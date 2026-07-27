// Field-index policy — the third thing this app provisions, after schemas and
// reactors. Two independent policies live on the same `/indexes/{field}`
// document: a VALUE index (exact and ordered access to a component's value) and a
// TEXT index (analyzed terms for `fts`). Everything below the KEYED_FIELDS list is
// about the first; `TEXT_FIELDS` and `ensureTextIndex` at the bottom are the
// second, and `title` is the only field carrying both.
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
 * exact title, and the blocker picker's search does not either: it goes through
 * the TEXT index at the bottom of this file, which is a different structure over
 * the same field. Every key in an `orderBy` must be value-indexed or the engine
 * gives up the index-ordered scan and sorts the whole result: 36ms against 252ms
 * at ten thousand todos. That is the one case where a field earns an index without
 * ever appearing on the left of a comparison.
 *
 * Deliberately NOT indexed: fields only ever READ out of a matched row (`order`,
 * `danger`, `minRank`, `showWhenDenied`, `due`). Projection does not need a value
 * index, and each one would be write cost for nothing.
 *
 * `tags` is the interesting absence, because the board's tag filter DOES match on
 * it. It matches it as a VAR (`[?t tags ?tags]`) and then tests membership with an
 * expression, so the plain field path already covers it — nothing is ever looked up
 * by the value of a whole list, and a value index over one would be an index of
 * list identities. Verified on the demo rather than assumed: one page under a tag
 * filter is ~270ms at 10,003 todos with no index on the field at all.
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

/**
 * The analyzed TEXT index — a second, independent policy on the same field.
 *
 * A value index answers "which rows have this exact title"; nothing in this app
 * ever asked that, and it would be the wrong question for a picker anyway. The
 * blocker picker needs "which rows have this WORD in their title somewhere", and
 * that is a different index: `fullText` builds one searchable document per entity
 * per analyzer, out of the field's text components only.
 *
 * `title` is the only field that earns one, and it earns it for one control. The
 * board never searches — it filters on values it already has an index for — so
 * this list is one entry and should stay short: the text index is the more
 * expensive of the two per write, and it is the one that can be BEHIND canonical
 * facts, in which case a search fails closed (`fts index not ready: sequence …`)
 * rather than answering from stale rows.
 *
 * Measured turning it on over the demo's 10,003 titles: the PATCH returned
 * `active` with `textSearch{state ready lag 0}` in 3.6s, having built 49,880
 * postings over 10,036 documents, and the database file went from 32.2 to 48.4
 * MiB. So it is not free, and it is affordable exactly once.
 */
export const TEXT_FIELDS = ["title"] as const;

/** The Snowball algorithm the picker's search is analyzed with, on both sides:
 *  the same pipeline runs over the stored title and over the typed query, which is
 *  why "land" finds "① Design landing page" — both stem to `land` — and "landi"
 *  finds nothing. It is a stemmer, not a prefix matcher. */
const ANALYZER = "english";

/**
 * Give `field` an analyzed text index, if it does not already have one.
 *
 * PATCH rather than PUT, deliberately: PUT replaces BOTH desired sections, so a
 * PUT carrying only `fullText` would silently reset `title`'s value index back to
 * `default` and cost the board its ordered scan (36ms against 252ms at ten
 * thousand todos). PATCH sets one section and preserves the other — verified on
 * the demo copy, where `valueIndex{enabled true source explicit}` survived
 * unchanged.
 *
 * Like `ensureValueIndex` this reads the ACTIVE section, so a field that is
 * desired-enabled but still building is not re-patched. Note the third state the
 * docs call out and this app will not hit: a text index over a field with no text
 * facts yet reports `dormant`, which is healthy rather than an error.
 */
export async function ensureTextIndex(field: string): Promise<"enabled" | "current"> {
  const { etag, body } = await policy(field);
  const active = body.slice(body.indexOf("active"), body.indexOf("catchUp"));
  const analyzers = /fullText\{analyzers\[([^\]]*)\]/.exec(active)?.[1] ?? "";
  if (analyzers.split(/\s+/).includes(ANALYZER)) return "current";

  const res = await fetch(`${BASE}/indexes/${encodeURIComponent(field)}`, {
    method: "PATCH",
    headers: { Accept: RON, "Content-Type": "application/ron", "If-Match": etag },
    body: `fullText {analyzers [${ANALYZER}]}\n`,
  });
  if (res.status === 412) return "current";
  if (!res.ok) throw new Error(`text index ${field}: ${res.status} ${await res.text()}`);
  return "enabled";
}
