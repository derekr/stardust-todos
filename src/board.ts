// Linear-style filtering, grouping, and aggregates — powered by Stardust
// queries. Multi-value membership uses `contains {#set …}`; the bare `not` verb
// only handles single-fact absence, and an `or(owned, not …)` scope was verified to
// leak across tenants — so those shapes are avoided. Blocked-ness and the effective
// status are no longer derived on read at all: they are stored facts the board and
// counts reactors JOIN, so the counts fold here is a plain tally over a group key
// Stardust already handed us.

import type { WorkspaceCtx } from "./workspace.ts";
import type { Priority, Status, Todo } from "./todos.ts";
import { effectiveStatusOf } from "./todos.ts";
import { type EntityId, refId } from "./stardust.ts";
import { blockers, blockersOfTodo, counts, todoPicker, workspaceTags } from "./queries.ts";

/** Effective display status for one row. `done` wins over blocked.
 *
 *  Prefers the STORED fact, which is what every reactor projects now; the
 *  computation is the fallback for a caller holding a row it assembled itself (the
 *  detail page, which already has the blocker list in hand). The rule itself lives
 *  in todos.ts next to the write paths that record it — one definition, whether it
 *  is being rendered or being written. */
export const effectiveStatus = (t: Pick<Todo, "status" | "blocked" | "effectiveStatus">): Status =>
  t.effectiveStatus ?? effectiveStatusOf(t.status, t.blocked === true);

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
 * GONE: the session reactor applies every filter server-side over the stored
 * effective status, so `renderBoard` just renders `readSnapshot`. The snapshot is
 * the single source of truth, ordered by the stored priority ordinal — and it is
 * ONE PAGE of it, since the body carries `limit`/`offset`, so nothing here should
 * treat those rows as the whole answer. See session.ts.)
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
 * visible set as the board. It was a viewer-scoped dry-run for exactly as long as
 * "a reactor has no viewer parameter" looked true; the viewer is a per-read BIND,
 * so one stored reactor (`counts`) serves every workspace and viewer. It projects
 * {effectiveStatus, priority} for the viewer's visible todos.
 *
 * The tally stays app-side, but it no longer DERIVES the group key — it used to
 * fold a per-row `blocked` (a correlated exists, at the board's own cost) into an
 * effective status here. Both are stored facts now, so this is a count. Making it a
 * `groupBy` aggregate in the reactor is finally possible and deliberately not done:
 * the chips want every value present with a zero, and two tallies over the same
 * hundreds of rows are not what costs anything on this page.
 */
export async function aggregateCounts(ctx: WorkspaceCtx, viewerPersonaId: number): Promise<Counts> {
  const rows = await counts.read({
    ws: { "#": ctx.workspaceId },
    viewer: { "#": viewerPersonaId },
  });
  const status: Record<string, number> = {};
  const priority: Record<string, number> = {};
  for (const r of rows) {
    status[r.effectiveStatus] = (status[r.effectiveStatus] ?? 0) + 1;
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
  const rows = await blockers.read({ ws: { "#": ctx.workspaceId } });
  const map = new Map<EntityId, Blocker[]>();
  for (const r of rows) {
    const id = refId(r.todo);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push({ id: refId(r.blocker), title: r.title as string, status: r.status as Status });
  }
  return map;
}

/**
 * The blockers of ONE todo.
 *
 * The detail page used to call `blockerMap` — a whole-workspace read of every
 * dependency edge — and then keep exactly one entry. This asks for that entry.
 */
export async function blockersOf(todoId: EntityId): Promise<Blocker[]> {
  const rows = await blockersOfTodo.read({ todo: { "#": todoId } });
  return rows.map((r) => ({ id: refId(r.blocker), title: r.title as string, status: r.status as Status }));
}

/** Distinct tag labels used in the workspace. */
export async function availableTags(ctx: WorkspaceCtx): Promise<string[]> {
  const rows = await workspaceTags.read({ ws: { "#": ctx.workspaceId } });
  return [...new Set(rows.map((r) => r.label as string))];
}

/** VISIBLE todos as {id,title} — the "add blocker" picker. Scoped to the viewer
 *  so you can't pick (and thus depend on) a draft you can't see. */
export async function todoOptions(
  ctx: WorkspaceCtx,
  viewerPersonaId: number,
): Promise<{ id: EntityId; title: string }[]> {
  return (await todoPicker.read({
    ws: { "#": ctx.workspaceId },
    viewer: { "#": viewerPersonaId },
  })) as { id: EntityId; title: string }[];
}
