// Linear-style filtering, grouping, and aggregates — powered by Stardust
// queries. Multi-value membership uses `contains {#set …}`; correlated negation
// (blocked/ready) uses `exists`/`notExists` subqueries (see derive.ts). The bare
// `not` verb only handles single-fact absence, and an `or(owned, not …)` scope was
// verified to leak across tenants — so those shapes are avoided. Counts are a
// per-viewer projection folded here (the group key, EFFECTIVE status, is derived
// on read, so it can't be a stored-field groupBy aggregate).

import type { WorkspaceCtx } from "./workspace.ts";
import type { Priority, Status, Todo } from "./todos.ts";
import { type EntityId, query, refId } from "./stardust.ts";
import { query as tquery } from "./typed-query.ts"; // compile-time-checked query for static literals
import { APP } from "./tenancy.ts";
import { openBlockerExists, visibleTo } from "./derive.ts";

/** Effective display status: "blocked" is DERIVED (not stored). `done` wins. */
export const effectiveStatus = (t: Pick<Todo, "status" | "blocked">): Status =>
  t.blocked && t.status !== "done" ? "blocked" : t.status;

type DerivedView = "all" | "ready" | "overdue" | "mine" | "done";
type GroupBy = "none" | "status" | "priority";

export interface Filter {
  status: Status[]; // empty = all (multi-select via `contains {#set ...}`)
  priority: Priority[];
  tags: string[];
  view: DerivedView;
  group: GroupBy;
}

export const emptyFilter: Filter = {
  status: [],
  priority: [],
  tags: [],
  view: "all",
  group: "status",
};

/**
 * (The board's filtering used to be split — a session reactor for priority +
 * visibility, then an app-side residual tail for status/tags/views. That tail is
 * GONE: the session reactor now computes effectiveStatus via a bound `exists` and
 * applies every filter server-side, so `renderBoard` just renders `readSnapshot`.
 * The snapshot is the single source of truth. See session.ts.)
 */

export interface Counts {
  status: Record<string, number>;
  priority: Record<string, number>;
}

/**
 * Effective-status + priority counts for the filter chips — VIEWER-SCOPED.
 *
 * Once visibility is per-viewer (drafts), ws-wide counts would leak and mislead
 * ("Blocked 3" when you can see 1), so counts must be tallied over the SAME
 * visible set as the board. That can't be a shared per-workspace reactor (a
 * reactor has no viewer parameter), so it's a viewer-scoped dry-run: project
 * {status, priority, blocked} for the viewer's visible todos and tally here.
 */
export async function aggregateCounts(ctx: WorkspaceCtx, viewerPersonaId: number): Promise<Counts> {
  const rows = (await query({
    find: ["?t", "?status", "?priority"],
    where: [
      ["?t", "app", APP],
      ["?t", "workspace", { "#": ctx.workspaceId }],
      ["?t", "status", "?status"],
      ["?t", "priority", "?priority"],
      ...visibleTo(viewerPersonaId),
    ],
    then: { project: { status: "?status", priority: "?priority", blocked: openBlockerExists("?t") } },
  })) as Array<Pick<Todo, "status" | "priority" | "blocked">>;
  const status: Record<string, number> = {};
  const priority: Record<string, number> = {};
  for (const r of rows) {
    const eff = effectiveStatus(r);
    status[eff] = (status[eff] ?? 0) + 1;
    priority[r.priority] = (priority[r.priority] ?? 0) + 1;
  }
  return { status, priority };
}

export interface Blocker {
  id: EntityId;
  title: string;
  status: Status;
}

/** Map of todo id -> its blockers (all dep edges in the workspace, one query).
 *
 *  NOTE: stays on raw `query` (not tquery) deliberately. `?t`/`?b` are the ids we
 *  want, but they're bound through REF fields (`todo`/`blocker`), so Stardust
 *  projects them as refs `{"#":n}` — while the typed-query checker models a
 *  subject-position var as a bare `@id` number and its runtime validator then
 *  rejects the ref. Typing this correctly needs the checker to understand
 *  ref-bound projections (a typed-query enhancement), so `refId` normalizes here. */
export async function blockerMap(ctx: WorkspaceCtx): Promise<Map<EntityId, Blocker[]>> {
  const rows = (await query({
    find: ["?t", "?b", "?bt", "?bs"],
    where: [
      ["?d", "kind", "dep"],
      ["?d", "todo", "?t"],
      ["?t", "workspace", { "#": ctx.workspaceId }],
      ["?d", "blocker", "?b"],
      ["?b", "title", "?bt"],
      ["?b", "status", "?bs"],
    ],
  })) as [unknown, unknown, string, Status][];
  const map = new Map<EntityId, Blocker[]>();
  for (const [t, b, bt, bs] of rows) {
    const id = refId(t);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push({ id: refId(b), title: bt, status: bs });
  }
  return map;
}

/** Distinct tag labels used in the workspace. */
export async function availableTags(ctx: WorkspaceCtx): Promise<string[]> {
  const rows = await tquery({
    find: ["?label"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", "?t"],
      ["?t", "workspace", { "#": ctx.workspaceId }],
      ["?e", "label", "?label"],
    ],
    orderBy: ["?label"],
    then: { project: { label: "?label" } }, // Stardust shapes+validates each row
  } as const);
  return [...new Set(rows.map((r) => r.label))];
}

/** VISIBLE todos as {id,title} — the "add blocker" picker. Scoped to the viewer
 *  so you can't pick (and thus depend on) a draft you can't see. */
export async function todoOptions(
  ctx: WorkspaceCtx,
  viewerPersonaId: number,
): Promise<{ id: EntityId; title: string }[]> {
  const rows = (await query({
    find: ["?t", "?title"],
    where: [
      ["?t", "app", APP],
      ["?t", "workspace", { "#": ctx.workspaceId }],
      ["?t", "title", "?title"],
      ...visibleTo(viewerPersonaId),
    ],
    orderBy: ["?title"],
    then: { project: { id: "?t", title: "?title" } },
  })) as { id: EntityId; title: string }[];
  return rows;
}
