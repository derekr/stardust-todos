// Tags, in two representations, and the one file that keeps them equal.
//
// A tag has always been an EDGE ENTITY here (`kind:'tag'`, `todo`, `label`) and
// still is: the edge is the vocabulary `availableTags()` groups over, it is what
// `tagsOfTodo` reads for the detail page, and it keeps a label a piece of data
// rather than a column. What is new is that the todo ALSO carries its labels as a
// component of its own — `tags ['design' 'launch']` — written by the same
// transaction that writes the edge.
//
// ## Why the board could not filter on the edge
//
// The board's tag filter was the app's last correlated `exists`: a subquery over
// the edges, bound to `?t`, asking "does this row carry any selected label". It was
// not slow, it was BROKEN, and the two failures are different ceilings:
//
//   ?tag=design                200   82.7s   50 rows
//   ?tag=design,launch         200   77.7s   50 rows
//   ?tag=design,launch,api     200   60.4s    0 rows   <- silently empty
//
// The third one is not a timeout. A subquery's OUTPUT is capped at 1,000 rows per
// directive (`where subquery row/output limit exceeded (per directive max 1000)`),
// which is a different limit from the 10,000-execution budget `blocked` ran into —
// that one counts EXECUTIONS across the whole query, this one counts ROWS out of
// one directive. At ~425 tag edges per label, two labels pass at 850 and three fail
// at 1,275, so the ceiling moves with the tag VOCABULARY's density and not with the
// number of todos. The app swallowed the engine's refusal and rendered an empty
// board, which is worse than a 500: a filter that silently matches nothing looks
// like an answer.
//
// ## Why the component is a LIST and not one field per label
//
// The obvious denormalisation is a presence field per label (`tag/design true`), so
// the filter is a plain fact clause. It is right for ONE label and cannot express
// two, because Stardust has no disjunction of PATTERNS: `or` is an expression over
// values that are already bound, and the tutorial says so directly ("Stardust uses
// expression `or` for local boolean choices, but a membership test is cleaner when
// you are checking one value against a small set").
//
// This is worth being precise about, because the failure is silent. Measured on a
// 10,000-todo copy of the demo, one page, against 9,948 visible rows:
//
//   ["or", ["?t","tag/design",true], ["?t","tag/launch",true]]   9,948 matching
//   ["or", ["?t","tag/design",true]]                             9,948 matching
//   no tag clause at all                                         9,948 matching
//   ["?t","tag/design",true]                                       420 matching
//
// A fact pattern inside `or` is not a query error and it is not a pattern: it is a
// three-element LIST, which is truthy, so the whole `or` is a constant `true` and
// the filter matches everything. Fast, plausible, and a superset — the failure mode
// this codebase already names as the one nobody notices.
//
// So the labels travel as one component holding all of them. An array field is
// Stardust's own answer to cardinality-many, and it binds as a runtime LIST — one
// row per todo, whatever the row's tags are, which is the duplicate that forced the
// `exists` in the first place. Membership is then an ordinary expression over a
// bound value, exactly the shape `visibleTo` uses:
//
//   ["?t", "tags", "?tags"]
//   ["any", ["fn", ["l"], ["contains", {"#set": ["design","launch"]}, "l"]], "?tags"]
//
// Measured on that same corpus, one page of fifty (the read a browser waits on):
//
//   | tag filter        | before (exists) | after (component) |
//   | ---               | ---             | ---               |
//   | none              | 83ms            | 83ms              |
//   | one label         | 104,475ms       | 84ms              |
//   | two labels        | 105,642ms       | 84ms              |
//   | three labels      | REFUSED (82s)   | 84ms              |
//   | five labels       | REFUSED         | 84ms              |
//
// Flat in the number of labels, because the labels are one set literal in one
// expression rather than N more subquery executions. The whole result set is
// identical to what the `exists` returned where the `exists` could still run: 420
// rows for `design`, 841 for `design,launch`, in the same order, every id once.
//
// The component needs no value index. The clause binds `?tags` as a var, which the
// plain field path already covers, and the membership test is an expression over a
// value the row already carries — so there is nothing to look up by value.
//
// ## What that gives up
//
// The same thing `blocked` gave up, and it is why this file also holds a guard.
// Correctness moves from the query to WRITE DISCIPLINE: the component is only as
// true as the paths that maintain it (`addTag`/`removeTag` in features.ts, which
// write the edge and the component in ONE transaction). `reconcileTags()` asks both
// questions plainly and reports every todo the two disagree on; `migrateTagComponents()`
// writes what it reports, which is what backfills a database whose edges predate
// the component.

import { type EntityId, query, refId, transact } from "./stardust.ts";
import { APP } from "./tenancy.ts";

/** A label longer than this is not a label. Titles are the field for sentences. */
export const TAG_LABEL_MAX = 40;

/** A label this app refuses to store. Its own class so a caller can tell a bad
 *  label from a broken database. */
export class TagLabelError extends Error {}

/**
 * A tag label, checked — the ONE place a label becomes query or write material.
 *
 * Both directions go through it: `addTag`/`removeTag` before the label is stored,
 * and `tagClauses` before it is compiled into a body. Two checks over one boundary,
 * the same arrangement `inDomain` has in board-query.ts, and for the same reason —
 * the second one is three lines and the failure it prevents is a query that means
 * something other than what it says.
 *
 * What is checked, and what is deliberately NOT. A label is a VALUE here: it rides
 * in the `{#set …}` literal of a JSON body and in an array component, never as a
 * field name and never as text spliced into RON. So `o'brien`, `a b` and `üñî` are
 * all fine, and all three were verified to match exactly the rows they should. Had
 * the label become a FIELD NAME (`tag/<label>`, the design this one replaced) the
 * charset would have had to be the safe field-name charset instead, because
 * `ronBind` in stardust.ts still builds RON by hand with no escaping.
 *
 * A COMMA is refused, and that one is not hygiene. `encodeFilter` joins selected
 * labels with commas and `decodeFilter` splits on them, so a label containing one
 * could never survive the round trip through a URL — it would come back as two
 * labels that are not in the vocabulary, and the board would answer 400 for a link
 * the app itself produced.
 */
export function tagLabel(raw: string): string {
  const label = raw.trim();
  if (!label) throw new TagLabelError("a tag label cannot be empty");
  if (label.length > TAG_LABEL_MAX) throw new TagLabelError(`tag label '${label}' is longer than ${TAG_LABEL_MAX}`);
  if (label.includes(",")) {
    throw new TagLabelError(`tag label '${label}' contains a comma, which the filter URL splits on`);
  }
  // A scan rather than a regex: a control-character CLASS in a regex is itself a
  // lint error, and the rule reads better out loud anyway.
  if ([...label].some((c) => c < "\u0020" || c === "\u007f")) {
    throw new TagLabelError(`tag label '${label}' contains a control character`);
  }
  return label;
}

/** The labels a todo should carry, in the canonical order the component stores
 *  them in. Sorted so that rewriting an unchanged set is `unchanged:1` at the
 *  engine rather than a new fact. */
export const canonicalTags = (labels: readonly string[]): string[] => [...new Set(labels.map(tagLabel))].sort();

/**
 * The board's tag membership test: does this row carry ANY of the selected labels?
 *
 * Two clauses, whatever the number of labels. The first binds the row's whole tag
 * list — so a todo with three selected labels is still one row — and the second is
 * a membership test over a set literal the caller supplies. Nothing is correlated,
 * nothing is a subquery, and there is no per-directive ceiling to reach.
 */
export const tagClauses = (labels: readonly string[]): unknown[] => [
  ["?t", "tags", "?tags"],
  ["any", ["fn", ["l"], ["contains", { "#set": canonicalTags(labels) }, "l"]], "?tags"],
];

/** A todo whose stored `tags` component disagrees with its tag EDGES. */
export interface TagDivergence {
  id: EntityId;
  /** the component as stored, or undefined when the todo carries none */
  stored: string[] | undefined;
  /** what the edges say it should be */
  actual: string[];
}

/**
 * Does the stored `tags` component still equal the tag EDGES, for every todo?
 *
 * The guard for what the denormalisation gives up, in the shape `reconcileBlocked`
 * established: ask the plain questions, compare, report — never repair, so a caller
 * can decide whether a divergence is a bug or a backfill.
 *
 * Two scans, no subquery, so it has no size at which it stops working. A todo
 * carrying no component at all is a divergence when it has edges, and a todo
 * carrying one with no edges left is a divergence too — that is the direction a
 * removal gets wrong.
 *
 * `[?t title ?title]` is what keeps a DELETED todo out of it. Deleting a todo
 * leaves its tag edges behind (the same way it leaves its dep edges), and the
 * edge's `todo` fact still binds a dead id — so without a clause that only a live
 * todo can satisfy, every deleted todo would be reported as missing its component
 * forever.
 *
 * The components are read as a bare `find` TUPLE, and that is the only shape that
 * gives back the list. An array component is stored as a nested LIST ENTITY, so
 * `then.project` and `GET /entities/{id}` both hand back a ref to it (`{"#": 92}`)
 * while `find ["?t" "?tags"]` resolves it to `["design","launch"]`. Expressions see
 * the list too, which is what makes the board's membership test work — but a caller
 * that reads a todo's tags off `readEntity` gets a ref and no error.
 */
export async function reconcileTags(workspaceId?: EntityId): Promise<TagDivergence[]> {
  const scope = workspaceId === undefined ? [] : [["?t", "workspace", { "#": workspaceId }]];
  const [edges, components] = await Promise.all([
    query({
      find: ["?t", "?label"],
      where: [
        ["?e", "kind", "tag"],
        ["?e", "todo", "?t"],
        ["?e", "label", "?label"],
        ["?t", "title", "?title"], // a live todo — a dangling edge binds a dead id
        ...scope,
      ],
    }) as Promise<[unknown, string][]>,
    query({
      find: ["?t", "?tags"],
      where: [["?t", "app", APP], ["?t", "tags", "?tags"], ...scope],
    }) as Promise<[EntityId, string[]][]>,
  ]);

  const wanted = new Map<EntityId, string[]>();
  for (const [t, label] of edges) {
    const id = refId(t);
    wanted.set(id, [...(wanted.get(id) ?? []), label]);
  }
  const stored = new Map<EntityId, string[]>(components.map(([id, tags]) => [id, tags ?? []]));

  const key = (labels: readonly string[]) => [...labels].sort().join(" ");
  const out: TagDivergence[] = [];
  for (const [id, labels] of wanted) {
    const have = stored.get(id);
    if (have === undefined || key(have) !== key(labels)) out.push({ id, stored: have, actual: canonicalTags(labels) });
  }
  for (const [id, have] of stored) {
    if (!wanted.has(id) && have.length) out.push({ id, stored: have, actual: [] });
  }
  return out;
}

/**
 * Backfill the `tags` component onto todos whose edges predate it.
 *
 * Idempotent by construction rather than by a "has it run?" marker, like
 * `migrateDerivedFields`: it writes exactly what `reconcileTags` reports, so a
 * second run finds nothing and writes nothing, and a run after a partial write
 * fixes the partial rows. Retracting is `tags: null` — an empty array writes an
 * empty LIST, which is a fact saying "no tags" rather than the absence of one.
 */
export async function migrateTagComponents(): Promise<number> {
  const diverged = await reconcileTags();
  if (!diverged.length) return 0;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const d of diverged) patch[d.id] = { tags: d.actual.length ? d.actual : null };
  await transact(patch);
  return diverged.length;
}
