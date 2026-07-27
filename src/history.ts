// Activity feed / status history for a todo — read straight from Stardust's
// temporal substrate. No audit table, no created_at/updated_at columns.
//
// Every fact carries its transaction. A one-shot facts read for this entity +
// field returns that field's full change history (newest-first, each row a value
// + its tx); we then read those transactions for their commit time and actor.
// History and attribution are free properties of the fact log — no event replay.
//
// This read used to cost 44ms for 17 rows, which is the ratio that gave it away:
// it was ONE round trip for the facts and then ONE MORE PER ROW for the
// transaction entities, eighteen requests to render eight lines. Both halves of
// that were wrong and they are fixed separately.
//
// It reads what the page SHOWS. The detail pane renders the last eight entries and
// the function returned every one it could find, so the extra transactions were
// fetched, attributed and thrown away. `GET /facts` takes a `limit` and returns
// newest-first, so asking for the newest `limit` rows and reversing them is exactly
// the tail the template wanted. The row count in the timing log drops from 17 to 8
// because the read genuinely got smaller — that is a real reduction in work and
// also a smaller answer, and both halves of that sentence matter (a read that
// returns less is faster for reasons that are not always an improvement).
//
// And it attributes them in ONE query instead of one request each. The transaction
// entities are ordinary entities — `[?tx stardust/committed ?at]` matches them —
// so the whole page's worth is one dry-run. Two things about that query are not
// obvious and both were measured rather than assumed:
//
//   * The membership test is an `or` of `[= ?tx {# N}]`, NOT `[contains {#set …}
//     ?tx]`. A `#set` of refs against a var bound in SUBJECT position matches
//     NOTHING — 15ms, zero rows, and an activity feed with every timestamp blank —
//     while `[= ?tx {# N}]` with the same ref matches. Bare ids match neither. This
//     is the third entry in this repo's collection of set-membership tests that
//     come back fast and empty, and the only reason it was caught is that the probe
//     asserted a row count.
//   * `or` is a MACRO, and it has a size limit: twelve branches read fine and
//     fourteen fail with `query: macro expansion size exceeded`. So the ids are
//     chunked, ten at a time, and the chunks run together. At the size this page
//     asks for that is one query; the chunking is what keeps a caller passing a
//     bigger limit from getting an error instead of a history.
//
// `actor` and `causationId` are OPTIONAL on a transaction, and a `where` clause is
// an existence filter — binding them would silently drop every transaction that has
// no actor. They are read as DOTTED PROJECTION PATHS instead (`.actor`), which
// return the key absent rather than removing the row. That is safe here and would
// not be in a stored reactor: a field read only through a projection path is
// invisible to invalidation, so a subscriber would serve a stale value forever.
// This is a dry-run, which pushes nothing by definition. See AGENTS.md.
//
// Measured on the demo's busiest todo (17 status facts): 45.5ms for 17 rows and 18
// round trips, against 15.6ms for 8 rows and 2.

import { type EntityId, type Ref, query, readEntity, readFacts, refId } from "./stardust.ts";

export interface HistoryEntry {
  status: string;
  at: string; // ISO commit time
  tx: number;
  actor?: string; // who committed the change (from Tx-Meta-Actor)
  via?: string; // for workflow changes: the actor of the triggering transaction
}

/** How many entries the detail pane shows, and therefore how many this reads. It
 *  is the template's number on purpose — a read that fetches more than is rendered
 *  is work with nowhere to go. */
const HISTORY_LIMIT = 8;

/** `or` is a macro and expands per branch; fourteen `[= ?tx {# N}]` branches is
 *  `macro expansion size exceeded` and twelve is fine. Ten leaves room. */
const OR_BRANCHES = 10;

interface TxRow {
  /** a subject-position var comes back bare from some routes and as a ref from the
   *  projection; `refId` is the one helper that does not care which. */
  tx: Ref | number;
  at?: { "#utc"?: string };
  actor?: string;
  cause?: string;
}

/** Commit time + attribution for a set of transactions, in as few reads as the
 *  `or` macro's size limit allows. */
async function transactions(ids: readonly number[]): Promise<Map<number, TxRow>> {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += OR_BRANCHES) chunks.push(ids.slice(i, i + OR_BRANCHES));
  const results = await Promise.all(
    chunks.map((chunk) =>
      query<TxRow>({
        find: ["?tx"],
        where: [
          ["?tx", "stardust/committed", "?at"],
          ["or", ...chunk.map((n) => ["=", "?tx", { "#": n }])],
        ],
        // `at` is bound by the clause above; `actor` and `causationId` are optional
        // on a transaction, so they are read off the matched entity by PATH — a
        // `where` clause would drop the rows that have neither.
        then: { project: { root: "?tx", fields: { tx: "?tx", at: "?at", actor: ".actor", cause: ".causationId" } } },
      }),
    ),
  );
  return new Map(results.flat().map((r) => [refId(r.tx), r]));
}

/**
 * The status timeline for one todo, oldest → newest, at most `limit` entries.
 *
 * `GET /facts?entityId=<id>&field=status&limit=<n>` returns the newest `n` status
 * assertions with their transaction ids, newest-first — the change history as one
 * cheap read (each `status` fact only exists because that write actually changed
 * the value). We reverse to chronological order, then attribute the whole set from
 * its transactions in one more read: `stardust/committed` (commit instant) +
 * `actor` (+ `causationId`).
 */
export async function statusHistory(id: EntityId, limit: number = HISTORY_LIMIT): Promise<HistoryEntry[]> {
  const rows = await readFacts({ entityId: id, field: "status", limit });

  // Newest-first → chronological. One row per status assertion.
  const out: HistoryEntry[] = rows
    .filter((r) => typeof r.component === "string")
    .map((r) => ({ status: r.component as string, at: "", tx: refId(r.tx) }))
    .reverse();

  const txs = await transactions([...new Set(out.map((e) => e.tx).filter((tx) => tx > 0))]);

  // A workflow write carries `causationId` pointing at the transaction that
  // triggered it, so the feed can show *why* it fired. That hop is one more read
  // per hop and it is rare — nothing in this app writes a `workflow:` causation
  // today — so it stays a per-entry read rather than a second batched query.
  await Promise.all(
    out.map(async (e) => {
      const txe = txs.get(e.tx);
      if (!txe) return; // transaction unreadable — leave unattributed
      e.at = txe.at?.["#utc"] ?? "";
      const cause = String(txe.cause ?? "");
      e.actor = txe.actor ?? (cause.startsWith("workflow") ? "workflow" : undefined);
      const m = cause.match(/^workflow:tx:(\d+)$/);
      if (m) {
        try {
          const trigger = await readEntity(Number(m[1]));
          e.via = trigger.actor as string | undefined;
        } catch {
          /* trigger unreadable */
        }
      }
    }),
  );
  return out;
}
