// Linear-style filtering, grouping, and aggregates — powered by Stardust
// queries. Multi-value membership uses `contains {#set …}`; the bare `not` verb
// only handles single-fact absence, and an `or(owned, not …)` scope was verified to
// leak across tenants — so those shapes are avoided. Blocked-ness and the effective
// status are no longer derived on read at all: they are stored facts the board and
// counts reactors JOIN, so the counts fold here is a plain tally over a group key
// Stardust already handed us.

import type { WorkspaceCtx } from "./workspace.ts";
import type { Status, Todo } from "./todos.ts";
import { effectiveStatusOf } from "./todos.ts";
import { type EntityId, query, refId } from "./stardust.ts";
import { blockers, blockersOfTodo, counts, todoPicker, workspaceTags } from "./queries.ts";
import { visibleTo } from "./derive.ts";
import { APP } from "./tenancy.ts";

/** Effective display status for one row. `done` wins over blocked.
 *
 *  Prefers the STORED fact, which is what every reactor projects now; the
 *  computation is the fallback for a caller holding a row it assembled itself (the
 *  detail page, which already has the blocker list in hand). The rule itself lives
 *  in todos.ts next to the write paths that record it — one definition, whether it
 *  is being rendered or being written. */
export const effectiveStatus = (t: Pick<Todo, "status" | "blocked" | "effectiveStatus">): Status =>
  t.effectiveStatus ?? effectiveStatusOf(t.status, t.blocked === true);

/**
 * (The board's filtering used to be split — a reactor for priority + visibility,
 * then an app-side residual tail for status/tags/views. That tail is GONE: one
 * body applies every filter server-side over the stored effective status, so
 * `renderBoard` just renders `readSnapshot`. The snapshot is the single source of
 * truth, ordered by the stored priority ordinal — and it is ONE PAGE of it, since
 * the body carries `limit`/`offset`, so nothing here should treat those rows as
 * the whole answer. The `Filter` those rows were narrowed by lives in filter.ts
 * and arrives in the URL; the body that applies it is board-query.ts.)
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
  // Grouped in the ENGINE. This used to ask for every visible todo and tally them
  // here — 9,947 rows to render two numbers, and the single most expensive read on
  // the page at ten thousand todos. Grouping by both keys returns one row per
  // (effectiveStatus, priority) pair: twelve rows, which the folds below turn into
  // the two tallies the chips want. Measured: 224ms/9,947 rows -> ~130ms/12 rows,
  // and the app stops parsing a ten-thousand-row response on every render.
  const rows = await counts.read({
    ws: { "#": ctx.workspaceId },
    viewer: { "#": viewerPersonaId },
  });
  const status: Record<string, number> = {};
  const priority: Record<string, number> = {};
  for (const [eff, pri, n] of rows as unknown as [string, string, number][]) {
    status[eff] = (status[eff] ?? 0) + n;
    priority[pri] = (priority[pri] ?? 0) + n;
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
  // `groupBy` already made these distinct and ordered, so there is nothing left to
  // dedupe: the query returns the ten labels in use rather than the 4,246 tag edges
  // that carry them.
  const rows = (await workspaceTags.read({ ws: { "#": ctx.workspaceId } })) as unknown as [string, number][];
  return rows.map(([label]) => label);
}

/** VISIBLE todos as {id,title} — what the "add blocker" picker opens on, before
 *  anything is typed. Scoped to the viewer so you can't pick (and thus depend on)
 *  a draft you can't see, and capped at `PICKER_LIMIT` by the reactor. */
export async function todoOptions(
  ctx: WorkspaceCtx,
  viewerPersonaId: number,
): Promise<{ id: EntityId; title: string }[]> {
  return (await todoPicker.read({
    ws: { "#": ctx.workspaceId },
    viewer: { "#": viewerPersonaId },
  })) as { id: EntityId; title: string }[];
}

/** The top of the picker's search results. Twenty is a list a person reads, and
 *  it is also the `limit` in the top-k shape the docs give for an ordered `fts`
 *  read — so the bound is on the QUERY, not on a slice taken afterwards. */
export const SEARCH_LIMIT = 20;

/**
 * The same picker, narrowed by a WORD — the typeahead behind the search box.
 *
 * This is the first thing in the app to go through the text index rather than a
 * value index, and the reason is that the picker's question is not one a value
 * index can answer. `title` is value-indexed, so `[>= ?title 'Buy'] [< ?title
 * 'Buz']` is a real range read — measured at 84ms on the demo corpus, and it
 * finds `Buy coffee beans` correctly. It also cannot find `① Design landing page`
 * from "landing", because a range matches a PREFIX of the whole string and every
 * meaningful word in this data is in the middle of one. `fts` matches terms
 * wherever they fall: "landing" and "land" both return the four landing-page
 * todos, in 3ms.
 *
 * Three properties of that clause worth knowing before you edit it:
 *
 *   * The term is a VALUE in the body, the same way a facet filter is. It arrives
 *     from a browser, so it is trimmed and length-capped by the caller — but it is
 *     never spliced into text, and the body travels to `/reactors/dry-run` as
 *     JSON. That matters more here than anywhere else in the app: the ONE place
 *     this app builds RON by hand is `ronBind`, which wraps a string bind in
 *     single quotes with no escaping, so a stored reactor taking the term as `?q`
 *     answers a search for `o'brien` with `unknown bind var ?brien`. Measured, and
 *     the reason this read is a dry-run.
 *   * What bounds this read is the TERM, not the `limit`. `orderBy [[?score desc]
 *     ?t]` with a `limit` is the shape the docs call bounded top-k, and it really
 *     is one — but only while the query is the fts clause ALONE. Measured on the
 *     demo copy for a term matching 2,498 rows: bare, `limit 20` costs 4ms against
 *     17ms unlimited; with `title` joined it is 12ms; with this body's app,
 *     workspace and visibility clauses it is 42ms, which is what the same body
 *     costs with no `limit` at all. So `limit` is the post-filter it is everywhere
 *     else in this app the moment a real query surrounds the search, and it bounds
 *     the response and the render rather than the work. The read is affordable
 *     because the term narrows the candidate set — 3ms for a term matching four
 *     rows, 11ms for 625, 42ms for 2,498, against a corpus of 10,003 — which is
 *     the same reason an inlined facet filter beats a joined one.
 *   * It is deliberately NOT a stored reactor for a second reason as well: a
 *     reactor carrying `then.patch` cannot contain fts at all. Nothing here has
 *     one, but that is the boundary this clause lives inside.
 *
 * The visibility rule is the same `visibleTo` fragment every other read uses, with
 * the viewer inlined — a draft you cannot see is not a candidate, whether you
 * search for it or scroll to it.
 */
export function todoSearchBody(workspaceId: EntityId, viewerPersonaId: number, term: string): Record<string, unknown> {
  return {
    find: ["?t", "?title", "?score"],
    where: [
      ["fts", term, "?t", "?score"],
      ["?t", "app", APP],
      ["?t", "workspace", { "#": workspaceId }],
      ["?t", "title", "?title"],
      ...visibleTo(viewerPersonaId),
    ],
    orderBy: [["?score", "desc"], "?t"],
    limit: SEARCH_LIMIT,
    then: { project: { id: "?t", title: "?title" } },
  };
}

/** That body, run. A dry-run, so it always sees the current corpus. */
export async function searchTodoOptions(
  ctx: WorkspaceCtx,
  viewerPersonaId: number,
  term: string,
): Promise<{ id: EntityId; title: string }[]> {
  return await query<{ id: EntityId; title: string }>(todoSearchBody(ctx.workspaceId, viewerPersonaId, term));
}
