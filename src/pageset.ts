// The rows an open stream is LOOKING at, as facts — fifty leased slots, patched in
// place.
//
// The board used to be one big subscription: a reactor over the whole filtered set,
// re-emitting whenever anything in it changed. That is the wrong shape for a search
// UI at any size — it pushes membership churn while you are reading, and its cost
// follows the workspace rather than the screen. So the page is written down, and a
// small reactor (`page-rows`) joins those fifty rows back to the todos. Measured on
// a throwaway: editing a todo ON the page pushes; editing one OFF it is silent;
// membership moves only when the app rewrites the set.
//
// This is the ONE piece of per-reader state that earns its facts, and now that the
// filter beside it does not, it is worth writing down exactly why. A bind takes a
// SCALAR. Verified against 0.0.6: `#set`, `#list`, `#seq`, `#array`, `#tuple` and a
// bare JSON array are all rejected as bind values, and `contains {#set […]}` over an
// entity-id var silently returns `[]` while working perfectly well over text. So
// fifty rows cannot be NAMED to a stored reactor by any means except writing them
// down. One join over one page-set is one subscription; the alternative is fifty.
//
// What DID have to change is how they are written. The set used to be
// retract-and-recreate: read the current rows, null every one of them, mint fifty
// new entities. On an append-only store that is the most expensive way to say
// nothing. Measured on a throwaway, fifty rows, one transaction, rewriting the SAME
// page:
//
//   retract-and-recreate   152 asserted, 200 retracted,   0 unchanged, 51 entity ids
//   slots, whole doc         0 asserted,   0 retracted, 200 unchanged,  0 entity ids
//   slots, diffed            nothing sent at all
//
// and scrolling the page by ten rows costs ten asserts rather than fifty of each.
// The engine already suppresses a write of the same value to the same entity — it
// just never got the chance, because a new entity every time is never the same
// entity. Patching in place is what lets that suppression apply, and diffing
// app-side against what this process last wrote is what removes even the request.
//
// Three consequences of the slot shape, all deliberate:
//
//   * A page-set is LEASED, not created. Its identity is "the subscription currently
//     showing these rows", which is exactly the lifetime of one SSE connection — so
//     closing a stream returns it to an in-memory free list and the next stream
//     re-leases it, with no writes on either side. The pool grows to peak concurrency
//     and stops. (The old session entity outlived the tab that made it: the demo had
//     84 of them for twelve todos.)
//   * The pool survives a restart, because `kind pgset` is a query. `recoverPool()`
//     reads the page-sets and their slots back at boot, so a restart reuses fifty
//     entities rather than abandoning them. This assumes ONE server per database,
//     which is already true here (`ctx` and `viewPersona` are per-process); a second
//     process would need leases to be facts with an owner and an expiry.
//   * A recycled page-set is NOT cleared on release. For the moment between a lease
//     and its first render it still names the previous reader's rows. That is
//     deliberate and safe rather than sloppy: `page-rows` is an INVALIDATION signal,
//     not a data source — every emission makes the app re-read the page properly —
//     so a stale first emission causes a correct render and nothing else. Clearing
//     would cost fifty retractions on release plus fifty asserts on the next lease,
//     to protect a window in which the only reader re-reads anyway. Not clearing
//     also means two consecutive streams on the same page reuse the set for free.

import { type EntityId, query, refId, transact } from "./stardust.ts";
import { PAGE_SIZE } from "./board-query.ts";
import { pageRows } from "./queries.ts";

/** One leased page-set: the anchor entity, its slot entities, and what this
 *  process believes each slot currently names. The last of those is why a render
 *  that changes nothing sends nothing at all. */
export interface PageSet {
  readonly id: EntityId;
  /** slot entity ids, indexed by position */
  readonly slots: EntityId[];
  /** the todo each slot names, as far as this process knows */
  readonly names: (EntityId | null)[];
}

/** Page-sets with no stream behind them. In memory on purpose: a lease is not a
 *  fact about the world, it is a fact about this process, and a fact about this
 *  process does not belong in the database. */
const free: PageSet[] = [];

/** Lease a page-set: reuse an idle one, or create a new anchor. */
export async function leasePageSet(): Promise<PageSet> {
  const pooled = free.pop();
  if (pooled) return pooled;
  const r = await transact({ "#_ps": { kind: "pgset" } });
  const id = r.tempIds?.ps;
  if (id === undefined) throw new Error("page-set: transact returned no id");
  return { id, slots: [], names: [] };
}

/** Give a page-set back. No I/O: closing a stream is free. */
export function releasePageSet(ps: PageSet): void {
  free.push(ps);
}

/** The IDLE page-sets — what /page.json offers as a bind, and the honest size of
 *  the pool: it grows to peak concurrency and then stops. */
export const pooledPageSets = (): EntityId[] => free.map((p) => p.id);

/**
 * Adopt every page-set already in the database into the free list.
 *
 * Run once at boot. Without it a restart abandons its pool and mints a fresh fifty
 * entities per stream forever — the same accumulation the board reactor and the
 * session entity both had, arriving by a different route.
 *
 * Two queries, whatever the pool size: the anchors, then every slot with its
 * position and (if it has one) the todo it names. A slot whose `todo` has been
 * retracted has no `todo` fact at all, so it simply does not appear in the second
 * query — which is the same reason `page-rows` stops matching it.
 */
export async function recoverPool(): Promise<number> {
  const anchors = (await query({ find: ["?ps"], where: [["?ps", "kind", "pgset"]] })) as [EntityId][];
  if (!anchors.length) return 0;
  const slots = (await query({
    find: ["?p", "?ps", "?i"],
    where: [
      ["?p", "kind", "pg"],
      ["?p", "pgset", "?ps"],
      ["?p", "slot", "?i"],
    ],
  })) as [EntityId, { "#": EntityId }, number][];
  const named = new Map(
    (
      (await query({
        find: ["?p", "?t"],
        where: [
          ["?p", "kind", "pg"],
          ["?p", "todo", "?t"],
        ],
      })) as [EntityId, { "#": EntityId }][]
    ).map(([p, t]) => [p, refId(t)]),
  );

  const byAnchor = new Map<EntityId, [EntityId, number][]>();
  for (const [slot, ps, i] of slots) {
    const key = refId(ps);
    if (!byAnchor.has(key)) byAnchor.set(key, []);
    byAnchor.get(key)!.push([slot, i]);
  }
  for (const [id] of anchors) {
    const mine = (byAnchor.get(id) ?? []).sort((a, b) => a[1] - b[1]);
    free.push({
      id,
      slots: mine.map(([slot]) => slot),
      names: mine.map(([slot]) => named.get(slot) ?? null),
    });
  }
  return free.length;
}

/**
 * Point a page-set's slots at `ids` — the only write on the board's read path.
 *
 * Returns what the transaction did, or `null` when it did not need to happen. That
 * second case is the common one: every emission re-renders, and most renders are
 * the same fifty rows again.
 *
 * A slot past the end of the page has its `todo` RETRACTED rather than left behind.
 * That matters more here than anywhere else in the app: a stale slot keeps a todo
 * live on a page it has scrolled off, so the subscription would quietly widen every
 * time anyone turned a page.
 */
export async function showPage(ps: PageSet, ids: readonly EntityId[]): Promise<PageWrite | null> {
  if (ids.length > PAGE_SIZE) throw new Error(`page-set: ${ids.length} rows exceeds the ${PAGE_SIZE}-slot page`);
  const have = ps.slots.length;
  const patch: Record<string, Record<string, unknown>> = {};

  // Grow the slots to what this page needs, once. Slots are never destroyed: a
  // page that shrinks retracts a `todo` and the slot waits for the next page.
  for (let i = have; i < ids.length; i++) {
    patch[`#_s${i}`] = { kind: "pg", pgset: { "#": ps.id }, slot: i, todo: { "#": ids[i]! } };
  }
  // And re-point the ones that already exist, skipping every slot that already
  // names the right todo. This is the diff that makes a repeat render free.
  for (let i = 0; i < have; i++) {
    const want = ids[i] ?? null;
    if (ps.names[i] === want) continue;
    patch[String(ps.slots[i])] = { todo: want === null ? null : { "#": want } };
  }
  if (!Object.keys(patch).length) return null;

  const r = await transact(patch);
  // Only now, because a transact is atomic: if it threw, `names` still describes
  // the database and the next render sends the same patch again.
  for (let i = have; i < ids.length; i++) {
    const slot = r.tempIds?.[`s${i}`];
    if (slot === undefined) throw new Error("page-set: slot transact returned no id");
    ps.slots.push(slot);
    ps.names.push(ids[i]!);
  }
  for (let i = 0; i < have; i++) ps.names[i] = ids[i] ?? null;
  return {
    asserted: r.asserted,
    retracted: r.retracted,
    unchanged: r.unchanged,
    minted: Math.max(0, ids.length - have),
  };
}

/** What one page-set write cost, for the x-ray and the harness. */
export interface PageWrite {
  asserted: number;
  retracted: number;
  unchanged: number;
  /** slot entities created — nonzero only while a page-set is growing to its first
   *  full page, and zero forever after. */
  minted: number;
}

/** The rows of the page this stream is on, live. */
export function watchPage(ps: PageSet, onRows: (rows: PageRow[]) => void, signal: AbortSignal): Promise<void> {
  return pageRows.watch({ ps: { "#": ps.id } }, (rows) => onRows(rows as PageRow[]), signal);
}

/** One row of the current page, as `page-rows` projects it. */
export interface PageRow {
  id: EntityId | { "#": EntityId };
  title: string;
  status: string;
  priority: string;
  effectiveStatus: string;
  blocked: boolean;
  done: boolean;
}

/**
 * A canonical key for one emission — the app's own result-equality suppression.
 *
 * `page-rows` has no `orderBy` and does not need one (the render re-reads the page
 * in the board's order), so the key is sorted. `id` is normalised because `?t` is
 * bound as the OBJECT of a ref field and may arrive as `{"#": n}`.
 *
 * This is what makes a stream open cost ONE board read instead of two. The old loop
 * subscribed first, and the empty first emission triggered a render, and that
 * render's page-set write invalidated the reactor, and the echo triggered a second
 * identical render — the `pushed` fast path that was supposed to prevent it had been
 * dead since `watchPage` stopped passing a snapshot through. Painting BEFORE
 * subscribing and then dropping any emission that matches what was painted removes
 * the echo without guessing: an emission that differs in any field this page can
 * show is still a repaint, so nothing is suppressed that a reader would have seen.
 */
export const frameKey = (rows: readonly PageRow[]): string =>
  rows
    .map(
      (r) =>
        `${typeof r.id === "number" ? r.id : refId(r.id)}|${r.title}|${r.status}|${r.priority}|` +
        `${r.effectiveStatus}|${r.blocked}|${r.done}`,
    )
    .sort()
    .join("\n");
