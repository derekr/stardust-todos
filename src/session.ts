// A "search session" that lives in Stardust — the SINGLE source of truth.
//
// The filter state is facts (a `session` entity + `sf` facet child entities);
// ONE canonical reactor computes effectiveStatus (blocked-aware) and applies
// EVERY filter — priority, status(effective), tags, the derived views
// (ready/overdue/mine/done), and viewer visibility — entirely server-side, then
// projects the fully-shaped, fully-filtered board rows. Clients read that snapshot
// and render it; there is no app-side filtering layer. Each session reads the one
// reactor via a per-stream bind (`?bind={sid …}`).
//
// NOTE: as of the v4 schema there ARE stored `blocked`/`effectiveStatus` facts,
// maintained by the write paths in todos.ts, because a correlated `exists` shares a
// 10,000-execution budget across the whole query and so caps this board at a few
// thousand todos. This reactor deliberately still derives its own — until it is
// rewritten to read the stored fields, the two answers exist side by side and can
// be compared, which is how the write paths are held honest (`reconcileBlocked`).
//
// The key that makes derived-value filtering possible in a reactor: BIND a
// correlated `exists` subquery to a variable — `[[exists {…}] ?blocked]` — then
// `?blocked` is an ordinary per-row boolean usable in `cond`/`or`/`and`. (A bare
// `exists` inlined into an expression runs UNCORRELATED and silently returns true
// for every row — always bind-then-use.) effectiveStatus is then
// `[[cond [and ?blocked [!= ?status done]] "blocked" true ?status] ?eff]`, and the
// status filter is a value-join of the session's facts onto `?eff`.
//
// Todos are a point-in-time SNAPSHOT: a one-shot read always recomputes, and the
// live stream re-emits whenever the RESULT changes. There is no revision counter
// and no explicit refresh: the facet rows and the session's scalars are top-level
// clauses, so writing them invalidates on their own. Measured against Stardust
// directly — retracting a status facet with no other write pushed 7 rows -> 3, and
// putting it back pushed 3 -> 7, while a bump of a counter field pushed nothing at
// all because the result had not changed.

import {
  type EntityId,
  createSchemaEntity,
  patchSchemaEntity,
  query,
  readEntity,
  readResults,
  streamResults,
  transact,
} from "./stardust.ts";
import { sessionSchema } from "./schemas.ts";
import { validators } from "./field-registry.ts";
import { ensureReactor } from "./reactors.ts";
import type { Filter } from "./board.ts";
import { APP } from "./tenancy.ts";

// EFFECTIVE status (blocked-aware); the status facet filters on this. Priorities
// as stored. Empty facet = "all" (materialized — an absent join matches nothing).
const STATUS_DOMAIN = ["todo", "doing", "blocked", "done"] as const;
const PRIORITY_DOMAIN = ["low", "med", "high"] as const;
const NOW_ISO = "2026-07-11T00:00:00Z"; // fixed demo "now" for overdue (matches board.ts)

export interface SnapshotRow {
  id: EntityId;
  title: string;
  status: string; // stored status
  priority: string;
  effectiveStatus: string; // derived by THIS reactor (blocked overrides, done wins)
  done: boolean;
  blocked: boolean; // derived by THIS reactor ($exists); also a stored fact — see the header
  overdue: boolean; // DERIVED ($exists: not-done + due < now)
  draft?: boolean;
  lastActor?: string;
}

export interface SessionHandle {
  sessionId: EntityId;
  workspaceId: EntityId;
}

const depSub = {
  capture: { t: "?t" },
  find: ["?e"],
  where: [
    ["?e", "kind", "dep"],
    ["?e", "todo", "?t"],
    ["?e", "blocker", "?b"],
    ["?b", "status", "?bs"],
    ["!=", "?bs", "done"],
  ],
};
const overdueSub = {
  capture: { t: "?t" },
  find: ["?due"],
  where: [
    ["?t", "due", "?due"],
    ["<", "?due", { "#utc": NOW_ISO }],
    ["?t", "status", "?st"],
    ["!=", "?st", "done"],
  ],
};
const tagSub = {
  capture: { t: "?t", sess: "?sess" },
  find: ["?e"],
  where: [
    ["?e", "kind", "tag"],
    ["?e", "todo", "?t"],
    ["?e", "label", "?l"],
    ["?ft", "kind", "sf"],
    ["?ft", "session", "?sess"],
    ["?ft", "facet", "tag"],
    ["?ft", "value", "?l"],
  ],
};

// The ONE canonical board reactor. A session is selected by its `sid` (bind); its
// scalar fields (viewer/view/actor/tagActive/workspace) drive the filters, and its
// `sf` facet entities drive the multi-select value-joins. Every one of those is a
// top-level clause, so writing any of them re-emits — no revision counter needed.
// Projects the fully-filtered, fully-shaped board rows.
export function canonicalBody(): Record<string, unknown> {
  return {
    enabled: true,
    find: ["?t"],
    where: [
      ["?sess", "kind", "session"],
      ["?sess", "sid", "?sid"], // ?sid supplied per-stream via ?bind
      ["?sess", "viewer", "?viewer"],
      ["?sess", "view", "?view"],
      ["?sess", "actor", "?actor"],
      ["?sess", "tagActive", "?tagActive"],
      ["?sess", "workspace", "?ws"],
      // base todo facts
      ["?t", "app", APP],
      ["?t", "workspace", "?ws"],
      ["?t", "status", "?status"],
      ["?t", "priority", "?priority"],
      ["?t", "title", "?title"],
      ["?t", "done", "?done"],
      ["?t", "draft", "?draft"],
      ["?t", "author", "?author"],
      ["?t", "lastActor", "?lastActor"],
      // derived booleans (bind exists → correlated per-row var) + effectiveStatus
      [["exists", depSub], "?blocked"],
      [["exists", overdueSub], "?overdue"],
      [["cond", ["and", "?blocked", ["!=", "?status", "done"]], "blocked", true, "?status"], "?eff"],
      // viewer visibility (published OR authored by viewer)
      ["or", ["=", "?draft", false], ["=", "?author", "?viewer"]],
      // priority filter (value-join)
      ["?fp", "kind", "sf"],
      ["?fp", "session", "?sess"],
      ["?fp", "facet", "priority"],
      ["?fp", "value", "?priority"],
      // status filter (value-join on the DERIVED effective status)
      ["?fs", "kind", "sf"],
      ["?fs", "session", "?sess"],
      ["?fs", "facet", "status"],
      ["?fs", "value", "?eff"],
      // tag filter: bind "has a selected tag", keep unless a tag filter is active
      [["exists", tagSub], "?hasTag"],
      ["or", ["not", "?tagActive"], "?hasTag"],
      // derived-view filter (single-select), all over BOUND vars
      [
        "or",
        ["=", "?view", "all"],
        ["and", ["=", "?view", "ready"], ["=", "?eff", "todo"]],
        ["and", ["=", "?view", "overdue"], "?overdue"],
        ["and", ["=", "?view", "done"], ["=", "?eff", "done"]],
        ["and", ["=", "?view", "mine"], ["=", "?lastActor", "?actor"]],
      ],
    ],
    orderBy: ["?priority", "?title"],
    then: {
      project: {
        id: "?t",
        title: "?title",
        status: "?status",
        priority: "?priority",
        effectiveStatus: "?eff",
        done: "?done",
        blocked: "?blocked",
        overdue: "?overdue",
        draft: "?draft",
        lastActor: "?lastActor",
      },
    },
  };
}

/** The name this app provisions its board reactor under. */
export const BOARD_REACTOR = "board";

let reactorPromise: Promise<EntityId> | null = null;
/**
 * The canonical board reactor, provisioned at its fixed id. Idempotent — it
 * creates the reactor, updates it if `canonicalBody()` has changed since, or does
 * nothing. Memoized so the check costs one round trip per process, not per read.
 */
export function ensureBoardReactor(): Promise<EntityId> {
  return (reactorPromise ??= ensureReactor(BOARD_REACTOR, canonicalBody()).then((r) => r.id));
}

/**
 * Rewrite ALL of a session's facets in ONE transaction.
 *
 * It used to be a delete-then-create loop per facet — roughly fifteen
 * transactions for one filter click. Every one of them invalidated the board
 * reactor, so a subscriber watching the bound results stream saw the half-written
 * states go by: measured, a single filter change emitted six results with row
 * counts 8, 3, 8, 1, 8, 3. One transaction means one recompute, straight to the
 * final answer.
 *
 * The cost is that these rows no longer go through the `sf` schema — a transact
 * writes facts unchecked, and there is no batch form of
 * `POST /schemas/{id}/entities`. So the values are checked here first, against the
 * SAME generated validators the schema produces. That is a weaker guarantee (the
 * app asserting it, not the engine enforcing it) and worth knowing about; the
 * session's own scalars still go through their schema below, which is where the
 * enum that matters (`view`) lives.
 */
async function writeFacets(sessionId: EntityId, spec: { facet: string; values: readonly string[] }[]): Promise<void> {
  const existing = (await query({
    find: ["?f"],
    where: [
      ["?f", "kind", "sf"],
      ["?f", "session", { "#": sessionId }],
    ],
  })) as [EntityId][];

  const patch: Record<string, Record<string, unknown>> = {};
  // Retract the old rows in the same transaction that writes the new ones. An
  // `sf` entity is exactly these four facts, so nulling them empties it, and it
  // stops matching the reactor's `kind` clause.
  for (const [id] of existing) patch[id] = { kind: null, session: null, facet: null, value: null };

  let i = 0;
  for (const { facet, values } of spec) {
    if (!validators.facet(facet)) throw new Error(`unknown facet '${facet}'`);
    for (const value of values) {
      if (!validators.value(value)) throw new Error(`facet ${facet} value must be a string, got ${typeof value}`);
      patch[`#_f${i++}`] = { kind: "sf", session: { "#": sessionId }, facet, value };
    }
  }
  await transact(patch);
}

/** Create a search session (filter = everything, view=all) + ensure the reactor. */
export async function createSession(
  workspaceId: EntityId,
  viewerPersonaId: EntityId,
  actor: string,
): Promise<SessionHandle> {
  const created = await createSchemaEntity(await sessionSchema(), {
    kind: "session",
    workspace: { "#": workspaceId },
    viewer: { "#": viewerPersonaId },
    actor,
    view: "all",
    tagActive: false,
  });
  if (!created.ok) throw new Error(`session rejected: ${created.error.message}`);
  const sessionId = created.entityId;
  // sid = self, the bind selector. A patch through the same boundary, so the
  // session cannot drift out of its schema after creation either.
  const sid = await patchSchemaEntity(await sessionSchema(), sessionId, { sid: sessionId });
  if (!sid.ok) throw new Error(`session sid rejected: ${sid.error.message}`);
  await writeFacets(sessionId, [
    { facet: "status", values: STATUS_DOMAIN },
    { facet: "priority", values: PRIORITY_DOMAIN },
  ]);
  await ensureBoardReactor();
  return { sessionId, workspaceId };
}

/** Push the whole Filter into the session facts (+ view/actor/tagActive). */
export async function setFilter(h: SessionHandle, f: Filter, actor: string): Promise<void> {
  await writeFacets(h.sessionId, [
    { facet: "status", values: f.status.length ? f.status : STATUS_DOMAIN },
    { facet: "priority", values: f.priority.length ? f.priority : PRIORITY_DOMAIN },
    { facet: "tag", values: f.tags },
  ]);
  const r = await patchSchemaEntity(await sessionSchema(), h.sessionId, {
    view: f.view,
    group: f.group, // display-only, but per-session state, so it lives here too
    actor,
    tagActive: f.tags.length > 0,
  });
  // `view` is an enum in the schema, so an unknown view is refused here rather
  // than silently producing a board that matches nothing.
  if (!r.ok) throw new Error(`filter rejected: ${r.error.message}`);
}

/** The current fully-filtered board snapshot — a one-shot read (always recomputes). */
export async function readSnapshot(h: SessionHandle): Promise<SnapshotRow[]> {
  const rid = await ensureBoardReactor();
  return (await readResults(rid, { sid: h.sessionId })) as SnapshotRow[];
}

/**
 * Watch this session's board. Stardust pushes the complete new result whenever the
 * result CHANGES — a filter write, a scope change, or a todo field in the top-level
 * `where` — so the server does not have to notice anything itself. An emission means
 * the rows differ; writing a field without changing the result pushes nothing.
 *
 * TOP-LEVEL clauses are the reliable trigger, and they cover rows that did not
 * exist when the stream opened: a brand-new entity the top-level clauses match
 * invalidates too, and only for the binds it actually matches (measured on the
 * `command-menu` reactor — see AGENTS.md, "What a subscription pushes").
 *
 * The one measured gap is TAG edges. Adding a tag pushes nothing — verified from a
 * background script and again with the tag filter active, so even an edge that
 * changes which rows match is invisible here. DEP edges do push (measured twice),
 * as do todo field writes from anywhere including the CLI, so this is narrower than
 * "subqueries don't invalidate": it is specifically the tag path. Treat the board as
 * a snapshot that advances on its own filter writes, on field writes, and on
 * dependency changes.
 */
export async function watchSnapshot(
  h: SessionHandle,
  onRows: (rows: SnapshotRow[]) => void,
  signal: AbortSignal,
): Promise<void> {
  const rid = await ensureBoardReactor();
  await streamResults(rid, (rows) => onRows(rows as SnapshotRow[]), signal, { sid: h.sessionId });
}

/**
 * The Filter a session currently encodes, read back out of Stardust.
 *
 * The session IS the filter state, so the server holds none: two browsers on the
 * same board have two sessions and two independent filters. Note the encoding
 * this has to invert — an empty facet is materialized as the whole domain (an
 * absent join matches nothing), so a full set reads back as "no filter". Picking
 * every value by hand is therefore indistinguishable from picking none, which is
 * exactly how the UI treats them anyway.
 */
export async function readFilter(h: SessionHandle): Promise<Filter> {
  const [e, rows] = await Promise.all([
    readEntity(h.sessionId),
    query({
      find: ["?facet", "?value"],
      where: [
        ["?f", "kind", "sf"],
        ["?f", "session", { "#": h.sessionId }],
        ["?f", "facet", "?facet"],
        ["?f", "value", "?value"],
      ],
    }) as Promise<[string, string][]>,
  ]);
  const of = (facet: string) => rows.filter(([f]) => f === facet).map(([, v]) => v);
  const unDomain = (vals: string[], domain: readonly string[]) => (vals.length >= domain.length ? [] : vals);
  return {
    status: unDomain(of("status"), STATUS_DOMAIN) as Filter["status"],
    priority: unDomain(of("priority"), PRIORITY_DOMAIN) as Filter["priority"],
    tags: of("tag"),
    view: (e.view as Filter["view"]) ?? "all",
    group: (e.group as Filter["group"]) ?? "status",
  };
}

/**
 * Point a session at a different workspace or viewer.
 *
 * The scope is facts ON the session, so switching workspace or "view as" has to
 * move the session too — otherwise the board keeps rendering the old scope. Both
 * fields are top-level clauses in the reactor, so the write re-emits by itself.
 */
export async function retargetSession(
  h: SessionHandle,
  workspaceId: EntityId,
  viewerPersonaId: EntityId,
): Promise<void> {
  const r = await patchSchemaEntity(await sessionSchema(), h.sessionId, {
    workspace: { "#": workspaceId },
    viewer: { "#": viewerPersonaId },
  });
  if (!r.ok) throw new Error(`session retarget rejected: ${r.error.message}`);
}
