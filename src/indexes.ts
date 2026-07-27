// Value-index policy — the third thing this app provisions, after schemas and
// reactors.
//
// Stardust maintains entity/transaction/field/backlink paths for free, but a
// clause that matches a VALUE (`["?c", "kind", "command"]`, or `?sid` supplied as
// a bind) is not covered by them: the field path is ordered by entity and
// transaction, so the engine scans every fact of that field and filters the
// payload. The lab's explain calls this out per clause as "not component-indexed".
//
// A value index is opt-in per field, except for UTC/duration/UUID components which
// promote automatically. Measured on the demo database, toggling the whole set off
// and back on, the board reactor's p50 went 54ms -> 27ms as a dry-run and 54ms ->
// 29ms read through the stored reactor. The command and counts reactors land
// around 1-2ms.
//
// The cost is real and the docs are explicit about it: every explicit index adds
// write work and storage, and rebuilds read canonical facts. So this list is not
// "every field" — it is the fields this app's reactors actually KEY on, which is
// why it lives next to the queries rather than being derived from the schema.

import { BASE } from "./stardust.ts";

/**
 * Fields matched by value somewhere in `queries.ts`, `board-query.ts` or the
 * provisioning path — as a constant (`kind`, `scope`), as a bind (`ws`, `pgset`),
 * as an inlined literal (`workspace`, `priority`, `effectiveStatus`), or as a join
 * key between two clauses (`todo`, `blocker`). An inlined literal keys the same way
 * a bind does: the engine is still asked for the rows whose field equals a value,
 * and without an index it still scans every fact of that field.
 *
 * `title` is here for ORDERING, not for matching — nothing looks a todo up by its
 * title. Every key in an `orderBy` must be value-indexed or the engine gives up the
 * index-ordered scan and sorts the whole result: 36ms against 252ms at ten thousand
 * todos. That is the one case where a field earns an index without ever appearing
 * on the left of a comparison.
 *
 * Deliberately NOT indexed: fields only ever READ out of a matched row (`order`,
 * `danger`, `minRank`, `showWhenDenied`, `due`). Projection does not need a value
 * index, and each one would be write cost for nothing.
 */
export const KEYED_FIELDS = [
  "kind",
  "app",
  "workspace",
  // The page-set's join key. `sid`, `session`, `facet` and `value` used to be here
  // and are gone with the search session: the filter is a query string, so nothing
  // matches a facet row by value any more, and the only thing still keyed by a
  // per-stream identity is the fifty `pg` rows the live subscription joins.
  "pgset",
  "todo",
  "blocker",
  "status",
  "priority",
  // v4 derived fields. `effectiveStatus` is what the board's status filter matches
  // — as a LITERAL now (`[or [= ?eff todo] …]`) rather than as a value-join, which
  // needs the index just as much: an inlined comparison still has to find the rows
  // whose `effectiveStatus` is that value. `prank` is what the board orders by.
  // `blocked` is the borderline one and is listed honestly: `reconcileBlocked`
  // reads it as a VAR, which the plain field path already covers for free, so
  // nothing today keys on it. It is here for the filter the board will obviously
  // grow (`[?t blocked true]`), and it is the one entry on this list to drop again
  // if that never happens.
  "blocked",
  "effectiveStatus",
  "prank",
  "title",
  "scope",
  "cmdId",
  "label",
  "name",
  "target",
  "persona",
  "role",
  "author",
  "lastActor",
] as const;

const RON = "application/ron-seq";

/** The /indexes routes speak RON and are ETag-guarded; they are not the NDJSON
 *  record surface the rest of stardust.ts wraps, so they get their own tiny client. */
async function policy(field: string): Promise<{ etag: string; body: string }> {
  const res = await fetch(`${BASE}/indexes/${encodeURIComponent(field)}`, { headers: { Accept: RON } });
  if (!res.ok) throw new Error(`index policy ${field}: ${res.status}`);
  return { etag: res.headers.get("etag") ?? "", body: await res.text() };
}

/**
 * Give `field` an explicit value index, if it does not already have one.
 *
 * The "already enabled" test reads the ACTIVE section, not the desired one: a
 * field can be desired-enabled but still building, and re-patching that would be
 * a no-op write. This is a substring check rather than a RON parse — the document
 * is small and fixed-shape, and the app has no RON reader (it negotiates NDJSON
 * everywhere else).
 */
export async function ensureValueIndex(field: string): Promise<"enabled" | "current"> {
  const { etag, body } = await policy(field);
  const active = body.slice(body.indexOf("active"), body.indexOf("catchUp"));
  if (/valueIndex\{enabled true/.test(active)) return "current";

  const res = await fetch(`${BASE}/indexes/${encodeURIComponent(field)}`, {
    method: "PATCH",
    headers: { Accept: RON, "Content-Type": "application/ron", "If-Match": etag },
    body: "valueIndex enabled\n",
  });
  // 412 means someone else moved first — their write is as good as ours here.
  if (res.status === 412) return "current";
  if (!res.ok) throw new Error(`index ${field}: ${res.status} ${await res.text()}`);
  return "enabled";
}
