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
 * Fields matched by value somewhere in `queries.ts`, `session.ts` or the
 * provisioning path — as a constant (`kind`, `scope`), as a bind (`sid`, `ws`),
 * or as a join key between two clauses (`facet`/`value`, `session`, `todo`).
 *
 * Deliberately NOT indexed: fields only ever READ out of a matched row (`title`,
 * `order`, `danger`, `minRank`, `showWhenDenied`, `due`). Projection does not need
 * a value index, and each one would be write cost for nothing.
 */
export const KEYED_FIELDS = [
  "kind",
  "app",
  "workspace",
  "sid",
  "session",
  "facet",
  "value",
  "todo",
  "blocker",
  "status",
  "priority",
  "scope",
  "cmdId",
  "label",
  "name",
  "target",
  "persona",
  "role",
  "viewer",
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
