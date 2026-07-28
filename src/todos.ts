// Todo domain layer — now WORKSPACE-SCOPED.
//
// Every read and write takes a WorkspaceCtx (a capability you can only get by
// passing an access check in workspace.ts). Reads go through the workspace's
// pinned reactor; writes stamp the workspace ref and are guarded so you can
// never mutate a todo in a workspace you don't hold. Isolation is enforced in
// THREE independent layers:
//   1. types  — no todo call compiles without a WorkspaceCtx.
//   2. reads  — the reactor's where-clause is pinned to the workspace server-side.
//   3. writes — belongsTo() re-checks the fact before every mutation.

import { readFile } from "node:fs/promises";
import type { WorkspaceCtx } from "./workspace.ts";
import { ensureSchema, lookupRef, putRef } from "./registry.ts";
import { APP } from "./tenancy.ts";
import {
  type CheckLast,
  type EntityId,
  type MergePatch,
  TxConflictError,
  createSchemaEntity,
  deleteEntity,
  patchSchemaEntity,
  query,
  readEntity,
  readResults,
  readSchema,
  refId,
  streamResults,
  transact,
} from "./stardust.ts";
import { blockedByTodo, tagsOfTodo } from "./queries.ts";
import { recordTagsRemoved } from "./tags.ts";
import { validators } from "./field-registry.ts";
import type { SchemaFieldTypes } from "./generated/schema-fields.ts";

// Domain enums come straight from the schema-generated FIELD registry
// (src/generated/schema-fields.ts, `npm run gen:query`) — the honest primitive:
// Stardust has no "Todo" type, only fields whose values a schema validates. So
// these are "whatever the `status`/`priority` fields validate to", not a class.
export type Priority = SchemaFieldTypes["priority"]; // "low" | "med" | "high"
export type Status = SchemaFieldTypes["status"]; // "todo" | "doing" | "blocked" | "done"

// A projected board ROW — NOT a Stardust entity type. It's the shape this app
// reads together to render a row: the stored fields it needs (each typed from the
// schema field registry, so they can't drift from what Stardust validates on
// write), plus `id` and derived/visibility flags that are deliberately NOT schema
// fields. Assembled from field-level guarantees, not an ontological "Todo".
export interface Todo {
  id: EntityId; // Stardust entity id — not a schema field
  title: SchemaFieldTypes["title"];
  done: SchemaFieldTypes["done"];
  priority: SchemaFieldTypes["priority"];
  status: SchemaFieldTypes["status"]; // user intent: todo | doing | done (never stored as "blocked")
  blocked?: SchemaFieldTypes["blocked"]; // STORED, written by the transaction that causes it (see refreshDerived)
  effectiveStatus?: SchemaFieldTypes["effectiveStatus"]; // STORED, ditto — blocked overrides status, done wins
  prank?: SchemaFieldTypes["prank"]; // STORED priority ORDINAL (high 0, med 1, low 2) — orders numerically
  overdue?: boolean; // DERIVED on read (correlated $exists: not-done + due < now) — `now` is not a fact
  draft?: boolean; // row-level visibility (a DECLARED field), not part of the Todo schema
  lastActor?: SchemaFieldTypes["lastActor"];
}

interface TodoDoc {
  title: string;
  done: boolean;
  priority: Priority;
  workspace: { "#": EntityId };
  app: string;
  status?: Status;
  due?: { "#utc": string };
  project?: { "#": EntityId };
  lastActor?: string; // materialized: who last changed this todo (cheap per-row read)
  author?: { "#": EntityId }; // the creating persona — row-level visibility principal
  draft?: boolean; // draft = visible only to `author` until published
  blocked?: boolean; // has ≥1 not-done blocker — recorded by the causing transaction
  effectiveStatus?: Status; // blocked ? "blocked" : status, with done winning
  prank?: number; // priority ordinal, so orderBy sorts a number instead of a string
}

/** Legacy id cache — read once to adopt an existing schema, never written. */
const STATE_FILE = new URL("../.state.json", import.meta.url);

// Evolved schema. It has grown four times without a rewrite or downtime:
//   v1  title, done, priority
//   v2  + workspace, app                        (multi-tenancy)
//   v3  + status, due, project                  (richer exploration fields)
//   v4  + blocked, effectiveStatus, prank       (derivation moved to the write path)
// Old todos stay valid facts; new fields are optional, so nothing breaks. v4 is
// the one growth that needs a BACKFILL as well (migrateDerivedFields) — not
// because the schema demands it, but because a reader that matches on `blocked`
// would silently skip a row that has never been written one.
const TODO_SCHEMA = {
  title: "Todo",
  type: "object",
  required: ["title", "done", "workspace", "app"],
  properties: {
    title: { type: "string", minLength: 1 },
    done: { type: "boolean" },
    priority: { type: "string", enum: ["low", "med", "high"] },
    workspace: { type: "object" },
    app: { type: "string" },
    status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
    due: { type: "object" }, // Stardust instant {#utc ...}
    project: { type: "object" }, // ref to a project entity
    lastActor: { type: "string" },
    author: { type: "object" }, // ref to the creating persona (row-level visibility)
    draft: { type: "boolean" }, // author-only visible until published
    blocked: { type: "boolean" }, // ≥1 not-done blocker (a consequence, recorded)
    effectiveStatus: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
    prank: { type: "integer", minimum: 0, maximum: 2 }, // priority ordinal
  },
  additionalProperties: false,
};

const SCHEMA_NAME = "todo";
let schemaIdCache: EntityId | null = null;

async function readState(): Promise<{ schemaId?: EntityId }> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Create-or-reuse the Todo schema and GROW it in place.
 *
 * The id lives in Stardust as a `schemaRef` marker, not in a local file. It used
 * to be cached in .state.json, which meant a missing file produced ANOTHER schema
 * — the live demo collected five identical Todo schemas that way. A checkout that
 * still has the old file gets adopted once (its id is recorded as the marker) so
 * upgrading does not orphan the existing schema and its todos.
 */
export async function ensureTodoSchema(): Promise<EntityId> {
  if (schemaIdCache) return schemaIdCache;

  // one-time migration: adopt the id an older checkout cached on disk, so
  // upgrading records the existing schema instead of creating a second one.
  if ((await lookupRef("schemaRef", SCHEMA_NAME)) === undefined) {
    const legacy = (await readState()).schemaId;
    if (legacy && (await readSchema(legacy)).status === 200) await putRef("schemaRef", SCHEMA_NAME, legacy);
  }
  schemaIdCache = await ensureSchema(SCHEMA_NAME, TODO_SCHEMA);
  return schemaIdCache;
}

/**
 * Authorize a mutation and return the current entity (read once, reused).
 * A todo is writable only if it is owned by this workspace — the same boundary
 * the reactor enforces for reads, checked here as a field compare so a stray
 * cross-tenant id can never be mutated.
 */
async function authorizeWrite(ctx: WorkspaceCtx, id: EntityId): Promise<Record<string, unknown>> {
  const e = await readEntity(id);
  const ws = (e.workspace as { "#": EntityId } | undefined)?.["#"];
  if (ws !== ctx.workspaceId) throw new Error(`todo ${id} is not in workspace ${ctx.workspaceId}`);
  return e;
}

// ---- Derived fields, written by the transaction that causes them ---------
//
// `blocked`, `effectiveStatus` and `prank` are STORED. That reverses this app's
// previous rule (derive on read, never materialize), and the reason is a measured
// engine limit, not taste: the board derives `blocked` with a correlated `exists`,
// and Stardust caps TOTAL subquery executions at 10,000 per query as one shared
// budget. So a per-row `exists` hard-fails the board above ~5,000 todos and costs
// 15.7s unindexed at 2,000. The plain, uncorrelated form of the same question —
// "which todos have a not-done blocker" — is ONE scan, ~10ms for a whole workspace.
//
// What we are NOT doing is caching. Stardust's facts are the event log, so writing
// the consequence of a change is recording it, at the moment and for the reason it
// happened. The rule is therefore: THE TRANSACTION THAT CAUSES A CHANGE ALSO
// RECORDS THE CONSEQUENCE. A writeback reactor (`then.patch`) cannot do this job —
// verified in both directions, adding or retracting a dep edge does not fire one,
// only a write to the blocker's own `status` does, so a todo left `blocked:true`
// would stay wrong forever.
//
// The invariant this gives up is the one worth naming: correctness used to be a
// property of the QUERY and is now a property of WRITE DISCIPLINE. Every write path
// that can change the answer goes through here, and `reconcileBlocked()` is the
// cheap check that they all still do.

/** Priority as an ORDINAL. `orderBy ?priority` sorts the STRING — high, low, med. */
const PRANK: Record<Priority, number> = { high: 0, med: 1, low: 2 };

/** blocked overrides the stored status; `done` beats blocked. The ONE definition —
 *  board.ts renders with it, the write paths below store its result. */
export const effectiveStatusOf = (status: Status, blocked: boolean): Status =>
  blocked && status !== "done" ? "blocked" : status;

/**
 * The plain open-blocker query: every todo with ≥1 not-done blocker, as one
 * uncorrelated scan of the dep edges. This is the whole reason the derivation
 * moved to the write path — it answers for the entire workspace in about the time
 * one correlated `exists` costs per row.
 *
 * `?t` is bound only through the ref field `todo`, so the ids come back as refs.
 */
async function openBlockedSet(): Promise<Set<EntityId>> {
  const rows = (await query({
    find: ["?t"],
    where: [
      ["?d", "kind", "dep"],
      ["?d", "todo", "?t"],
      ["?d", "blocker", "?b"],
      ["?b", "status", "?bs"],
      ["!=", "?bs", "done"],
    ],
  })) as [unknown][];
  return new Set(rows.map(([t]) => refId(t)));
}

/** The todos that `id` BLOCKS — the reverse dep edge. A status write to `id`
 *  changes THEIR `blocked`, so this is who `refreshDerived` has to be called with. */
async function dependentsOf(id: EntityId): Promise<EntityId[]> {
  return (await blockedByTodo.read({ todo: { "#": id } })).map((r) => r.id);
}

/**
 * Recompute `blocked`/`effectiveStatus` for `ids` and write only what changed.
 *
 * One plain query (above) plus one entity read per affected id — and `ids` is
 * never the whole workspace on a write path, it is the dependents of the todo that
 * moved. Rows already holding the right values are dropped before the write, so
 * calling this after a no-op write costs a query and commits nothing.
 *
 * This is a `transact`, so it is a SECOND transaction after its cause, and it
 * bypasses the Todo schema. Both are deliberate and both have a reason:
 * `patchSchemaEntity` writes exactly one entity, and every consequence here lands
 * on a DIFFERENT entity than the cause; a transact is the only multi-entity write.
 * The schema bypass is the same trade `writeFacets` makes, so the two values are
 * checked here against the schema-generated validators instead.
 *
 * `cause` is the transaction that made this necessary; it is stamped as the
 * causation id, so the fact log says which write a derived fact came from.
 */
export async function refreshDerived(ids: readonly EntityId[], cause?: number): Promise<EntityId[]> {
  if (!ids.length) return [];
  const open = await openBlockedSet();
  const entities = await Promise.all(ids.map((id) => readEntity(id)));
  const patch: Record<string, Record<string, unknown>> = {};
  const changed: EntityId[] = [];
  ids.forEach((id, i) => {
    const e = entities[i]!;
    if (typeof e.status !== "string") return; // deleted, or never a todo
    const blocked = open.has(id);
    const effectiveStatus = effectiveStatusOf(e.status as Status, blocked);
    if (e.blocked === blocked && e.effectiveStatus === effectiveStatus) return;
    if (!validators.blocked(blocked) || !validators.effectiveStatus(effectiveStatus)) {
      throw new Error(`derived value for todo ${id} is not schema-shaped`);
    }
    patch[id] = { blocked, effectiveStatus };
    changed.push(id);
  });
  if (changed.length) await transact(patch, cause ? { causationId: `derive:tx:${cause}` } : {});
  return changed;
}

/**
 * The consequences of `patch` on the todo it is applied to, folded into the SAME
 * merge-patch — so a todo's own derived fields are never a second transaction.
 *
 * Its `blocked` is not among them: nothing a todo says about ITSELF can change
 * whether something else blocks it. That travels the other way, to the dependents.
 */
function selfDerived(e: Record<string, unknown>, patch: MergePatch<TodoDoc>): MergePatch<TodoDoc> {
  const out: MergePatch<TodoDoc> = {};
  const blocked = (patch.blocked ?? e.blocked) === true;
  const status = (patch.status ?? e.status ?? "todo") as Status;
  const effectiveStatus = effectiveStatusOf(status, blocked);
  if (e.effectiveStatus !== effectiveStatus) out.effectiveStatus = effectiveStatus;
  const priority = (patch.priority ?? e.priority) as Priority | undefined;
  if (priority && e.prank !== PRANK[priority]) out.prank = PRANK[priority];
  return out;
}

/**
 * Does stored `blocked` still equal the plain open-blocker query?
 *
 * The guard for what this design gives up. `blocked` is only as correct as the
 * write paths that maintain it, so this asks the engine the uncorrelated question
 * directly and reports every row the two disagree on — including a todo that
 * carries no `blocked` fact at all, which is a disagreement even when the answer
 * would have been `false`. Three queries, tens of milliseconds for a workspace:
 * cheap enough for a test, an import, or a boot.
 *
 * `workspaceId` narrows it to one tenant — which is the useful scope after an
 * import, and the affordable one when the database also holds a stress corpus.
 */
export interface BlockedDivergence {
  id: EntityId;
  stored: boolean | undefined;
  actual: boolean;
}

export async function reconcileBlocked(workspaceId?: EntityId): Promise<BlockedDivergence[]> {
  const scope = workspaceId === undefined ? [] : [["?t", "workspace", { "#": workspaceId }]];
  const [open, all, withField] = await Promise.all([
    openBlockedSet(),
    query({
      find: ["?t"],
      where: [
        ["?t", "app", APP],
        ["?t", "title", "?title"], // a todo has a title — `app` alone also matches markers
        ["?t", "status", "?status"],
        ...scope,
      ],
    }) as Promise<[EntityId][]>,
    query({
      find: ["?t", "?blocked"],
      where: [["?t", "app", APP], ["?t", "blocked", "?blocked"], ...scope],
    }) as Promise<[EntityId, boolean][]>,
  ]);
  const stored = new Map(withField);
  const out: BlockedDivergence[] = [];
  for (const [id] of all) {
    const was = stored.get(id);
    if (was !== open.has(id)) out.push({ id, stored: was, actual: open.has(id) });
  }
  return out;
}

// ---- Commands (all scoped to ctx) ----------------------------------------

export async function addTodo(
  ctx: WorkspaceCtx,
  title: string,
  priority: Priority = "med",
  extra: Partial<Pick<TodoDoc, "due" | "project" | "author" | "draft">> = {},
  actor?: string,
): Promise<EntityId> {
  const schemaId = await ensureTodoSchema();
  // ONE write: schema-validated todo, born with its workspace ref + app tag.
  // Every todo carries an `author` (its creating persona) and `draft` flag so
  // the row-level visibility predicate always binds. Defaults: authored by the
  // workspace persona, not a draft.
  //
  // It is also born with its derived fields, in the same transaction: a row that
  // has no dep edges yet cannot be blocked, so the consequence is known before the
  // cause is written and needs no query to establish.
  const created = await createSchemaEntity<TodoDoc>(
    schemaId,
    {
      title,
      done: false,
      status: "todo",
      priority,
      workspace: { "#": ctx.workspaceId },
      app: APP,
      lastActor: actor ?? "seed",
      author: { "#": ctx.personaId },
      draft: false,
      ...extra,
      blocked: false,
      effectiveStatus: "todo",
      prank: PRANK[priority],
    },
    { actor },
  );
  if (!created.ok) {
    const why = created.error.details.map((d) => `${d.instanceLocation} ${JSON.stringify(d.errors)}`).join(", ");
    throw new Error(`rejected by schema: ${why}`);
  }
  return created.entityId;
}

/**
 * THE choke point for every todo field write — and therefore the place the
 * consequences of one are recorded.
 *
 * The todo's OWN derived fields ride along in the same merge-patch: one
 * transaction, schema-validated, still guarded by `checkLast`. Its DEPENDENTS
 * cannot, because they are other entities and `patchSchemaEntity` writes one; they
 * get a second transaction, and only when the write could actually have moved them
 * — a status write. A priority or draft write cannot change anyone else's
 * `blocked`, so it stays a single round trip.
 */
async function patchTodo(
  ctx: WorkspaceCtx,
  id: EntityId,
  patch: MergePatch<TodoDoc>,
  actor?: string,
  checkLast?: CheckLast, // optimistic-concurrency guard: reject if the entity moved
): Promise<void> {
  const e = await authorizeWrite(ctx, id);
  const schemaId = await ensureTodoSchema();
  const full = { ...patch, ...selfDerived(e, patch), ...(actor ? { lastActor: actor } : {}) }; // + who changed it
  const r = await patchSchemaEntity<TodoDoc>(schemaId, id, full, { actor }, { checkLast });
  if (!r.ok) {
    if (r.status === 409) throw new TxConflictError(id, r.error); // stale write — caller re-renders truth
    throw new Error(`could not update ${id}`);
  }
  if (patch.status !== undefined || patch.done !== undefined) {
    await refreshDerived(await dependentsOf(id), refId(r.result.transaction));
  }
}

/**
 * The app's todos that carry NO `field` fact — the question every backfill below
 * asks, and the one shape of query that could not answer it at scale.
 *
 * All three used to ask Stardust directly, with `["not", ["?t", <field>, "?v"]]`.
 * A `not` is a SUBQUERY and it is correlated — executed once per candidate row —
 * so its output grows with the corpus against a per-directive cap of a thousand
 * rows. Past that it does not get slow, it hard-FAILS:
 *
 *   query: $.where[2]: query: where subquery row/output limit exceeded
 *   (per directive max 1000)
 *
 * and since all three run from the web server's boot sequence, the app refused to
 * START against any database holding more than a thousand todos — including every
 * stress corpus, none of whose rows are missing anything. A backfill that cannot
 * run on a large database is a backfill that has the size dependency exactly
 * backwards.
 *
 * So the difference is taken here instead: two plain scans, no subquery, no cap to
 * exceed. Measured against 10,003 todos (three of them genuinely unscoped): every
 * app todo is 28ms / 10,003 rows, the ones that have the field are 43ms / 10,000
 * rows, and the diff is exactly the three. 71ms, once, on the boot that needs it —
 * against a query that could not run at all. The set difference is the same set
 * difference; the only thing that moved is which side of the wire computes it.
 *
 * `title` is what separates a todo from an infra marker: registry.ts writes those
 * with `app` too, and they legitimately carry no workspace, author or actor.
 */
async function todosMissing(field: string): Promise<EntityId[]> {
  const scan = (extra: unknown[]) =>
    query({
      find: ["?t"],
      where: [["?t", "app", APP], ["?t", "title", "?title"], ...extra],
    }) as Promise<[EntityId][]>;
  const [every, have] = await Promise.all([scan([]), scan([["?t", field, "?v"]])]);
  const has = new Set(have.map(([id]) => id));
  return every.map(([id]) => id).filter((id) => !has.has(id));
}

/**
 * One-time: `status` is USER INTENT and never holds "blocked". Revert any legacy
 * rows the old worker overwrote to status "blocked" back to "todo". This survives
 * the v4 change unchanged and is the distinction v4 depends on: blocked-ness is
 * stored again, but in `blocked`/`effectiveStatus`, never by clobbering the intent
 * the user expressed. That is exactly what made the old worker impossible to undo.
 */
export async function migrateBlockedStatus(): Promise<number> {
  const rows = (await query({
    find: ["?t"],
    where: [
      ["?t", "app", APP],
      ["?t", "status", "blocked"],
    ],
  })) as [EntityId][];
  if (!rows.length) return 0;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [id] of rows) patch[id] = { status: "todo", done: false };
  await transact(patch);
  return rows.length;
}

/**
 * One-time: row-level visibility needs every todo to carry `author` + `draft`
 * so the visibility predicate always binds. Give legacy rows an author (the
 * workspace owner) and mark them published. Additive facts via generic transact.
 */
export async function migrateVisibilityFields(ownerPersonaId: EntityId): Promise<number> {
  const rows = await todosMissing("author");
  if (!rows.length) return 0;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const id of rows) patch[id] = { author: { "#": ownerPersonaId }, draft: false };
  await transact(patch);
  return rows.length;
}

/**
 * Demo seed: one DRAFT per persona so the "view as" toggle visibly changes —
 * each persona sees only their own draft (plus all published todos). Idempotent
 * by title.
 */
export async function ensureDemoDrafts(ctx: WorkspaceCtx, ownerId: EntityId, memberId: EntityId): Promise<void> {
  const titles = new Set(
    (
      (await query({
        find: ["?title"],
        where: [
          ["?t", "app", APP],
          ["?t", "workspace", { "#": ctx.workspaceId }],
          ["?t", "title", "?title"],
        ],
      })) as [string][]
    ).map((r) => r[0]),
  );
  const OWNER_DRAFT = "Draft — Q3 roadmap (owner only)";
  const MEMBER_DRAFT = "Draft — my 1:1 notes (teammate only)";
  if (!titles.has(OWNER_DRAFT)) {
    await addTodo(ctx, OWNER_DRAFT, "high", { author: { "#": ownerId }, draft: true }, "Owner");
  }
  if (!titles.has(MEMBER_DRAFT)) {
    await addTodo(ctx, MEMBER_DRAFT, "med", { author: { "#": memberId }, draft: true }, "Teammate");
  }
}

/** Publish a draft (make it workspace-visible). Only its author may publish.
 *  `expectTx` guards the transition the same way `setStatus` does. */
export async function publishTodo(
  ctx: WorkspaceCtx,
  id: EntityId,
  actingPersonaId: EntityId,
  expectTx?: number,
): Promise<void> {
  const e = await authorizeWrite(ctx, id); // workspace boundary
  const author = (e.author as { "#": EntityId } | undefined)?.["#"];
  if (author !== actingPersonaId) throw new Error(`only the author (persona ${author}) can publish this draft`);
  await patchTodo(ctx, id, { draft: false }, undefined, expectTx ? { [id]: expectTx } : undefined);
}

/**
 * Backfill the v4 derived fields onto todos written before they existed.
 *
 * Two queries — every todo with its status and priority, and the plain
 * open-blocker set — then one transaction for the rows that actually differ. So it
 * is idempotent by construction rather than by a "has it run?" marker: a second
 * run finds nothing to write and returns 0, and a run after a partial write fixes
 * exactly the partial rows.
 *
 * Note that this is the same computation `refreshDerived` does per row, in the
 * bulk shape. It stays separate because it is allowed to be O(workspace) — that
 * is what a migration is — while the write path deliberately is not.
 */
export async function migrateDerivedFields(): Promise<number> {
  const [rows, open, current] = await Promise.all([
    query({
      find: ["?t", "?status", "?priority"],
      where: [
        ["?t", "app", APP],
        ["?t", "status", "?status"],
        ["?t", "priority", "?priority"],
      ],
    }) as Promise<[EntityId, Status, Priority][]>,
    openBlockedSet(),
    // rows that already carry all three; anything missing one is simply absent
    query({
      find: ["?t", "?blocked", "?eff", "?prank"],
      where: [
        ["?t", "app", APP],
        ["?t", "blocked", "?blocked"],
        ["?t", "effectiveStatus", "?eff"],
        ["?t", "prank", "?prank"],
      ],
    }) as Promise<[EntityId, boolean, Status, number][]>,
  ]);
  const have = new Map(current.map(([id, blocked, eff, prank]) => [id, `${blocked}|${eff}|${prank}`]));
  const patch: Record<string, Record<string, unknown>> = {};
  let n = 0;
  for (const [id, status, priority] of rows) {
    const blocked = open.has(id);
    const effectiveStatus = effectiveStatusOf(status, blocked);
    const prank = PRANK[priority];
    if (have.get(id) === `${blocked}|${effectiveStatus}|${prank}`) continue;
    patch[id] = { blocked, effectiveStatus, prank };
    n++;
  }
  if (n) await transact(patch);
  return n;
}

/** One-time backfill: give app todos without a lastActor a placeholder. */
export async function backfillActor(): Promise<number> {
  const rows = await todosMissing("lastActor");
  if (!rows.length) return 0;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const id of rows) patch[id] = { lastActor: "seed" };
  await transact(patch);
  return rows.length;
}

// `done` (used by the web checkbox) and `status` are kept consistent: whichever
// you set, the other follows. `actor` is stamped on the transaction (attribution).
export async function setDone(ctx: WorkspaceCtx, id: EntityId, done: boolean, actor?: string): Promise<void> {
  await patchTodo(ctx, id, { done, status: done ? "done" : "todo" }, actor);
}

// A state-machine transition. Pass `expectTx` (the entity's last tx when the
// caller rendered the control) to guard against a stale write: if the todo
// changed since, the write is rejected with a TxConflictError instead of
// silently clobbering the newer state.
export async function setStatus(
  ctx: WorkspaceCtx,
  id: EntityId,
  status: Status,
  actor?: string,
  expectTx?: number,
): Promise<void> {
  await patchTodo(ctx, id, { status, done: status === "done" }, actor, expectTx ? { [id]: expectTx } : undefined);
}

export async function setPriority(ctx: WorkspaceCtx, id: EntityId, priority: Priority, actor?: string): Promise<void> {
  await patchTodo(ctx, id, { priority }, actor);
}

export async function toggleTodo(ctx: WorkspaceCtx, id: EntityId, actor?: string): Promise<boolean> {
  const e = await authorizeWrite(ctx, id); // reuse the read — no second fetch
  const next = !(e.done === true);
  await patchTodo(ctx, id, { done: next, status: next ? "done" : "todo" }, actor);
  return next;
}

/** Deleting a todo unblocks everything it was blocking: its dep edges survive it,
 *  but `[?b status ?bs]` no longer matches, so the dependents are open again. The
 *  reverse lookup has to happen BEFORE the delete, while the edges still resolve.
 *
 *  Its TAG edges survive it in exactly the same way, and that is why the labels are
 *  read here too. Nothing retracts a tag edge when its todo goes, but the edge stops
 *  joining to a workspace — so a delete can empty the workspace's vocabulary of a
 *  label without any tag write happening at all, and the chips would go on offering
 *  a label nothing carries. Read first, delete, then let `recordTagsRemoved` ask
 *  whether any of them were the last of their kind. */
export async function removeTodo(ctx: WorkspaceCtx, id: EntityId): Promise<void> {
  await authorizeWrite(ctx, id);
  const [dependents, labels] = await Promise.all([
    dependentsOf(id),
    tagsOfTodo.read({ todo: { "#": id } }).then((rows) => rows.map((r) => r.label as string)),
  ]);
  await deleteEntity(id); // DELETE /entities/{id} — not a transact, so it takes no patch
  await refreshDerived(dependents);
  if (labels.length) await recordTagsRemoved(ctx.workspaceId, labels);
}

// ---- Reads: Stardust projects the exact shape; no positional mapping -----

export async function listTodos(ctx: WorkspaceCtx): Promise<Todo[]> {
  return (await readResults(ctx.reactorId)) as Todo[];
}

export async function watchTodos(ctx: WorkspaceCtx, cb: (todos: Todo[]) => void, signal: AbortSignal): Promise<void> {
  await streamResults(ctx.reactorId, (rows) => cb(rows as unknown as Todo[]), signal);
}

// ---- Migration: pull legacy single-tenant todos into a workspace ---------

/**
 * Assign app-tagged todos that have NO workspace to `ctx`'s workspace.
 *
 * This is the one genuine migration in the app: todos written before workspaces
 * existed (commit 3ab2ee5, single-tenant) carry `app` and a `title` and nothing
 * that scopes them, and the read-time alternative — adopting them with an
 * `or(owned, not …)` scope clause — was tested and LEAKS across tenants. So they
 * have to actually be assigned, once, when the default workspace is first created.
 *
 * It asked that with a `not` until the whole family moved to `todosMissing` — see
 * the note there for why a correlated subquery could not answer it past a thousand
 * todos, and for the measurement that replaced it.
 */
export async function migrateOrphanTodos(ctx: WorkspaceCtx): Promise<number> {
  const rows = await todosMissing("workspace");
  if (!rows.length) return 0;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const id of rows) patch[id] = { workspace: { "#": ctx.workspaceId } };
  await transact(patch);
  return rows.length;
}
