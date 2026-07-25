// A "search session" that lives in Stardust — the SINGLE source of truth.
//
// The filter state is facts (a `session` entity + `sf` facet child entities);
// ONE canonical reactor computes effectiveStatus (blocked-aware) and applies
// EVERY filter — priority, status(effective), tags, the derived views
// (ready/overdue/mine/done), and viewer visibility — entirely server-side, then
// projects the fully-shaped, fully-filtered board rows. Clients read that snapshot
// and render it; there is no app-side filtering layer and no materialized derived
// facts. Each session reads the one reactor via a per-stream bind (`?bind={sid …}`).
//
// The key that makes derived-value filtering possible in a reactor: BIND a
// correlated `exists` subquery to a variable — `[[exists {…}] ?blocked]` — then
// `?blocked` is an ordinary per-row boolean usable in `cond`/`or`/`and`. (A bare
// `exists` inlined into an expression runs UNCORRELATED and silently returns true
// for every row — always bind-then-use.) effectiveStatus is then
// `[[cond [and ?blocked [!= ?status done]] "blocked" true ?status] ?eff]`, and the
// status filter is a value-join of the session's facts onto `?eff`.
//
// Todos are a point-in-time SNAPSHOT: a one-shot read always recomputes; the live
// stream re-emits when the session changes — a filter edit (setFilter) or an
// explicit `refresh()`, both of which bump the session's `rev`.

import { type EntityId, deleteEntity, query, readResults, transact } from "./stardust.ts";
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
  effectiveStatus: string; // DERIVED server-side (blocked overrides, done wins)
  done: boolean;
  blocked: boolean; // DERIVED ($exists over the dep graph)
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
// `sf` facet entities drive the multi-select value-joins. Patching the session
// (its `rev`) re-emits. Projects the fully-filtered, fully-shaped board rows.
export function canonicalBody(): Record<string, unknown> {
  return {
    enabled: true,
    find: ["?t"],
    where: [
      ["?sess", "kind", "session"],
      ["?sess", "sid", "?sid"], // ?sid supplied per-stream via ?bind
      ["?sess", "rev", "?rev"],
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

/** Rewrite one facet's `sf` entities (empty = the full domain, i.e. "all"). */
async function writeFacet(sessionId: EntityId, facet: string, values: readonly string[]): Promise<void> {
  const existing = (await query({
    find: ["?f"],
    where: [
      ["?f", "kind", "sf"],
      ["?f", "session", { "#": sessionId }],
      ["?f", "facet", facet],
    ],
  })) as [EntityId][];
  await Promise.all(existing.map(([id]) => deleteEntity(id)));
  const patch: Record<string, Record<string, unknown>> = {};
  values.forEach((v, i) => {
    patch[`#_f${i}`] = { kind: "sf", session: { "#": sessionId }, facet, value: v };
  });
  if (Object.keys(patch).length) await transact(patch);
}

// Bump `rev` to a fresh value so the reactor's top-level [?sess rev ?rev] clause
// invalidates and re-emits. A timestamp avoids a read-modify-write race.
async function bumpRev(sessionId: EntityId): Promise<void> {
  await transact({ [sessionId]: { rev: Date.now() } });
}

/** Create a search session (filter = everything, view=all) + ensure the reactor. */
export async function createSession(
  workspaceId: EntityId,
  viewerPersonaId: EntityId,
  actor: string,
): Promise<SessionHandle> {
  const r = await transact({
    "#_ss": {
      kind: "session",
      workspace: { "#": workspaceId },
      viewer: { "#": viewerPersonaId },
      actor,
      view: "all",
      tagActive: false,
      rev: 1,
    },
  });
  const sessionId = r.tempIds!.ss;
  await transact({ [sessionId]: { sid: sessionId } }); // sid = self, the bind selector
  await writeFacet(sessionId, "status", STATUS_DOMAIN);
  await writeFacet(sessionId, "priority", PRIORITY_DOMAIN);
  await ensureBoardReactor();
  return { sessionId, workspaceId };
}

/** Push the whole Filter into the session facts (+ view/actor/tagActive) and bump rev. */
export async function setFilter(h: SessionHandle, f: Filter, actor: string): Promise<void> {
  await writeFacet(h.sessionId, "status", f.status.length ? f.status : STATUS_DOMAIN);
  await writeFacet(h.sessionId, "priority", f.priority.length ? f.priority : PRIORITY_DOMAIN);
  await writeFacet(h.sessionId, "tag", f.tags);
  await transact({ [h.sessionId]: { view: f.view, actor, tagActive: f.tags.length > 0, rev: Date.now() } });
}

/** A qualifying action happened: bump `rev` so the stream pushes a fresh snapshot. */
export async function refresh(h: SessionHandle): Promise<void> {
  await bumpRev(h.sessionId);
}

/** The current fully-filtered board snapshot — a one-shot read (always recomputes). */
export async function readSnapshot(h: SessionHandle): Promise<SnapshotRow[]> {
  const rid = await ensureBoardReactor();
  return (await readResults(rid, { sid: h.sessionId })) as SnapshotRow[];
}
