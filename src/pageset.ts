// The rows a stream is currently LOOKING at, as facts.
//
// The board used to be one big subscription: a reactor over the whole filtered set,
// re-emitting whenever anything in it changed. That is the wrong shape for a search
// UI at any size — it pushes membership churn while you are reading, and its cost
// follows the workspace rather than the screen.
//
// So the page is written down. After a page is computed, its todo ids become `pg`
// facts, and a small reactor joins them back to the todos. Measured on a throwaway:
// editing a todo ON the page pushes; editing one OFF it is silent; membership moves
// only when the app rewrites the set. Cost is bounded by page size, not by corpus.
//
// This is the ONE part of the old search-session that earned its facts, and it is
// worth being exact about why, because the filter beside it did not. A bind takes a
// SCALAR. Verified against 0.0.6: `#set`, `#list`, `#seq`, `#array`, `#tuple` and a
// bare JSON array are all rejected as bind values, and `contains {#set […]}` over an
// entity-id var silently returns `[]` while working perfectly well over text. So
// fifty rows cannot be NAMED to a stored reactor by any means except writing them
// down. One join over one page-set is one subscription; the alternative is fifty.
//
// The set used to hang off the session entity, which is why it needed no identity
// of its own. With the filter in the URL there are no sessions, so a page-set is
// its own entity — `kind pgset`, created when a stream opens and deleted when it
// closes — and the reactor is bound to it by REF (`?bind={ps {# 1234}}`), which a
// bind does accept.

import { type EntityId, deleteEntity, query, refId, transact } from "./stardust.ts";
import { pageRows } from "./queries.ts";

/**
 * A page-set for one open stream.
 *
 * Created per stream rather than per browser: the identity a page-set needs is
 * "the subscription that is currently showing these rows", and that is exactly the
 * lifetime of the SSE connection. A session entity outlived the browser tab that
 * made it and accumulated forever — the demo had 84 of them for twelve todos.
 */
export async function leasePageSet(): Promise<EntityId> {
  const r = await transact({ "#_ps": { kind: "pgset" } });
  const id = r.tempIds?.ps;
  if (id === undefined) throw new Error("page-set: transact returned no id");
  return id;
}

/** Give a page-set back: its rows first, then the anchor. */
export async function releasePageSet(pgset: EntityId): Promise<void> {
  await writePageSet(pgset, []);
  await deleteEntity(pgset);
}

/**
 * Replace a page-set's rows with `ids`, in ONE transaction.
 *
 * Retraction matters more here than it did for the filter facts: a stale `pg` row
 * keeps a todo live on a page it has scrolled off, so the subscription would
 * quietly widen every time anyone turned a page. A `pg` entity is exactly these
 * three facts, so nulling them empties it and it stops matching the reactor's
 * `kind` clause.
 */
export async function writePageSet(pgset: EntityId, ids: readonly EntityId[]): Promise<void> {
  const existing = (await query({
    find: ["?p", "?todo"],
    where: [
      ["?p", "kind", "pg"],
      ["?p", "pgset", { "#": pgset }],
      ["?p", "todo", "?todo"],
    ],
  })) as [EntityId, { "#": EntityId }][];

  // Nothing to do when the page has not moved — and it usually has not, because
  // every render calls this and most renders are the same rows again.
  //
  // This is not a micro-optimisation. Stardust is APPEND-ONLY: a retraction is
  // more facts, so rewriting an identical set costs ~50 facts and 9 entity ids and
  // never gives them back. Before this check, merely LOOKING at the board wrote to
  // the database, and a demo with twelve todos had accumulated 22,872 facts.
  //
  // The engine already suppresses unchanged writes — but only for the same entity
  // with the same value, and retract-then-recreate mints new ids, so it could never
  // see one. The cheapest write remains the one not sent.
  const before = existing.map(([, todo]) => refId(todo));
  if (before.length === ids.length && before.every((id, i) => id === ids[i])) return;

  const patch: Record<string, Record<string, unknown>> = {};
  for (const [id] of existing) patch[id] = { kind: null, pgset: null, todo: null };
  ids.forEach((todo, i) => {
    patch[`#_p${i}`] = { kind: "pg", pgset: { "#": pgset }, todo: { "#": todo } };
  });
  if (Object.keys(patch).length) await transact(patch);
}

/** The rows of the page this stream is on, live. */
export function watchPage(pgset: EntityId, onRows: (rows: PageRow[]) => void, signal: AbortSignal): Promise<void> {
  return pageRows.watch({ ps: { "#": pgset } }, (rows) => onRows(rows as PageRow[]), signal);
}

/** One row of the current page. The same shape the board renders. */
export interface PageRow {
  id: EntityId;
  title: string;
  status: string;
  priority: string;
  effectiveStatus: string;
  blocked: boolean;
  done: boolean;
}
