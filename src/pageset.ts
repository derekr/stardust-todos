// The rows a session is currently LOOKING at, as facts.
//
// The board used to be one big subscription: a reactor over the whole filtered set,
// re-emitting whenever anything in it changed. That is the wrong shape for a search
// UI at any size — it pushes membership churn while you are reading, and its cost
// follows the workspace rather than the screen.
//
// So the page is written down. After a page is computed, its todo ids become `pg`
// facts on the session, and a small reactor joins them back to the todos. Measured
// on a throwaway: editing a todo ON the page pushes; editing one OFF it is silent;
// membership moves only when the app rewrites the set. Cost is bounded by page
// size, not by the corpus.
//
// The obvious question is why this is not just "subscribe to fifty entities".
// Because a bind takes a scalar — there is no way to bind a list — so fifty
// entities would mean fifty subscriptions. One join over one session's page-set is
// one subscription, and the set is data the app already had to compute.

import { type EntityId, query, transact } from "./stardust.ts";
import { sessionPage } from "./queries.ts";

/**
 * Replace a session's page-set with `ids`, in ONE transaction.
 *
 * Retraction matters more here than it does for facets: a stale `pg` row keeps a
 * todo live on a page it has scrolled off, so the subscription would quietly widen
 * every time anyone turned a page. A `pg` entity is exactly these three facts, so
 * nulling them empties it and it stops matching the reactor's `kind` clause —
 * the same trick `writeFacets` uses, for the same reason.
 */
export async function writePageSet(sessionId: EntityId, ids: readonly EntityId[]): Promise<void> {
  const existing = (await query({
    find: ["?p"],
    where: [
      ["?p", "kind", "pg"],
      ["?p", "session", { "#": sessionId }],
    ],
  })) as [EntityId][];

  const patch: Record<string, Record<string, unknown>> = {};
  for (const [id] of existing) patch[id] = { kind: null, session: null, todo: null };
  ids.forEach((todo, i) => {
    patch[`#_p${i}`] = { kind: "pg", session: { "#": sessionId }, todo: { "#": todo } };
  });
  if (Object.keys(patch).length) await transact(patch);
}

/** The rows of the page this session is on, live. */
export function watchPage(sid: number, onRows: (rows: PageRow[]) => void, signal: AbortSignal): Promise<void> {
  return sessionPage.watch({ sid }, (rows) => onRows(rows as PageRow[]), signal);
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
