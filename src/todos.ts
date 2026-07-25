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
  streamResults,
  transact,
} from "./stardust.ts";
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
  blocked?: boolean; // DERIVED on read (correlated $exists over the dep graph) — never stored, not in the schema
  overdue?: boolean; // DERIVED on read (correlated $exists: not-done + due < now) — same pattern as blocked
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
}

/** Legacy id cache — read once to adopt an existing schema, never written. */
const STATE_FILE = new URL("../.state.json", import.meta.url);

// Evolved schema. It has grown three times without a rewrite or downtime:
//   v1  title, done, priority
//   v2  + workspace, app        (multi-tenancy)
//   v3  + status, due, project  (richer exploration fields)
// Old todos stay valid facts; new fields are optional, so nothing breaks.
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
    },
    { actor },
  );
  if (!created.ok) {
    const why = created.error.details.map((d) => `${d.instanceLocation} ${JSON.stringify(d.errors)}`).join(", ");
    throw new Error(`rejected by schema: ${why}`);
  }
  return created.entityId;
}

async function patchTodo(
  ctx: WorkspaceCtx,
  id: EntityId,
  patch: MergePatch<TodoDoc>,
  actor?: string,
  checkLast?: CheckLast, // optimistic-concurrency guard: reject if the entity moved
): Promise<void> {
  await authorizeWrite(ctx, id);
  const schemaId = await ensureTodoSchema();
  const full = actor ? { ...patch, lastActor: actor } : patch; // materialize who changed it
  const r = await patchSchemaEntity<TodoDoc>(schemaId, id, full, { actor }, { checkLast });
  if (!r.ok) {
    if (r.status === 409) throw new TxConflictError(id, r.error); // stale write — caller re-renders truth
    throw new Error(`could not update ${id}`);
  }
}

/**
 * One-time: blocked-ness is now DERIVED on read, never stored. Revert any legacy
 * rows the old worker overwrote to status "blocked" back to "todo" (their user
 * intent). After this, `status` only ever holds todo | doing | done.
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
  const rows = (await query({
    find: ["?t"],
    where: [
      ["?t", "app", APP],
      ["?t", "title", "?title"], // a todo has a title — `app` alone also matches infra markers
      ["not", ["?t", "author", "?a"]],
    ],
  })) as [EntityId][];
  if (!rows.length) return 0;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [id] of rows) patch[id] = { author: { "#": ownerPersonaId }, draft: false };
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

/** One-time backfill: give app todos without a lastActor a placeholder. */
export async function backfillActor(): Promise<number> {
  const rows = (await query({
    find: ["?t"],
    where: [
      ["?t", "app", APP],
      ["?t", "title", "?title"], // ditto — never stamp lastActor onto a marker
      ["not", ["?t", "lastActor", "?a"]],
    ],
  })) as [EntityId][];
  if (!rows.length) return 0;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [id] of rows) patch[id] = { lastActor: "seed" };
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

export async function removeTodo(ctx: WorkspaceCtx, id: EntityId): Promise<void> {
  await authorizeWrite(ctx, id);
  await deleteEntity(id);
}

// ---- Reads: Stardust projects the exact shape; no positional mapping -----

export async function listTodos(ctx: WorkspaceCtx): Promise<Todo[]> {
  return (await readResults(ctx.reactorId)) as Todo[];
}

export async function watchTodos(ctx: WorkspaceCtx, cb: (todos: Todo[]) => void, signal: AbortSignal): Promise<void> {
  await streamResults(ctx.reactorId, (rows) => cb(rows as unknown as Todo[]), signal);
}

// ---- Migration: pull legacy single-tenant todos into a workspace ---------

/** Assign app-tagged todos that have NO workspace to `ctx`'s workspace. */
export async function migrateOrphanTodos(ctx: WorkspaceCtx): Promise<number> {
  const rows = (await query({
    find: ["?t"],
    where: [
      ["?t", "app", APP],
      ["?t", "title", "?title"], // ditto — a marker has no workspace and needs none
      ["not", ["?t", "workspace", "?w"]],
    ],
  })) as [EntityId][];
  if (!rows.length) return 0;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [id] of rows) patch[id] = { workspace: { "#": ctx.workspaceId } };
  await transact(patch);
  return rows.length;
}
