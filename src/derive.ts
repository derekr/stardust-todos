// Derive-on-read directives — the declarative replacement for the imperative
// workflow worker.
//
// Each is a CORRELATED `$exists` subquery for a reactor/query `then.project`.
// It's evaluated once per projected row (the `capture` map binds the outer var
// into the subquery — keys omit the leading "?"), and it's 0-safe: a row with
// no match still appears, projected as `false`.
//
// Why this eliminates the worker: blocked-ness and project rollup are computed
// on every READ, so they never need to be written back OR undone. The one thing
// Stardust can't do — reactively drive a join-derived state BACK when the
// condition ceases (no correlated antijoin in `where`, no reactor auto-retract)
// — simply never comes up, because nothing is materialized in the first place.

/**
 * The correlated "open blocker" subquery, shared by BOTH the projection `$exists`
 * directive and the `where`-clause `exists`/`notExists` functions — a single
 * definition of "≥1 dependency on a not-done blocker", correlated on `todoVar`
 * via `capture`. (A bare fact `not`/multi-clause join can't express this; only a
 * captured subquery correlates per-row. Verified against 0.0.4: as a standalone
 * `where` clause `exists`/`notExists` correlates correctly, but the same subquery
 * does NOT correlate nested inside a `cond`/expression or a `scalar` — so this
 * stays a top-level clause.)
 */
function openBlockerSubquery(todoVar: string): object {
  const key = todoVar.slice(1); // "?t" -> "t"
  return {
    capture: { [key]: todoVar },
    find: ["?e"],
    where: [
      ["?e", "kind", "dep"],
      ["?e", "todo", todoVar],
      ["?e", "blocker", "?b"],
      ["?b", "status", "?bs"],
      ["!=", "?bs", "done"],
    ],
  };
}

/** $exists projection directive: TRUE iff `todoVar` has ≥1 not-done blocker. */
export function openBlockerExists(todoVar: string): object {
  return { $exists: openBlockerSubquery(todoVar) };
}

/**
 * The same open-blocker check as a `where`-clause verb. `["exists", …]` keeps
 * rows that ARE blocked; `["notExists", …]` keeps rows that are NOT — the two
 * one-clause forms that replace the old two-query + JS set-difference for
 * blocked/ready. Feed straight into a raw `query` `where` (the typed-query
 * checker only models 3-tuples, so exists/notExists go through raw query).
 */
export function openBlockerClause(todoVar: string, negate: boolean): unknown[] {
  return [negate ? "notExists" : "exists", openBlockerSubquery(todoVar)];
}

/** $exists directive: TRUE iff `todoVar` is not done and has a due date before
 *  `nowIso`. Overdue is derived on read, exactly like blocked — no stored flag,
 *  no separate query. The whole predicate lives INSIDE the subquery so it's
 *  0-safe: a todo with no `due` fact simply yields false (the correlated $exists
 *  is the only way to compute this per-row over ALL todos — a `where`-level
 *  `["?t","due","?d"]` would inner-join out the dateless ones). */
export function overdueExists(todoVar: string, nowIso: string): object {
  const key = todoVar.slice(1); // "?t" -> "t"
  return {
    $exists: {
      capture: { [key]: todoVar },
      find: ["?due"],
      where: [
        [todoVar, "due", "?due"],
        ["<", "?due", { "#utc": nowIso }],
        [todoVar, "status", "?st"],
        ["!=", "?st", "done"], // a completed todo is never "overdue"
      ],
    },
  };
}

/** $exists directive: TRUE iff `projVar` has ≥1 not-done todo. */
export function openTodoExists(projVar: string): object {
  const key = projVar.slice(1);
  return {
    $exists: {
      capture: { [key]: projVar },
      find: ["?t"],
      where: [
        ["?t", "project", projVar],
        ["?t", "status", "?s"],
        ["!=", "?s", "done"],
      ],
    },
  };
}

/** $exists directive: TRUE iff `projVar` has ≥1 todo at all. */
export function anyTodoExists(projVar: string): object {
  const key = projVar.slice(1);
  return { $exists: { capture: { [key]: projVar }, find: ["?t"], where: [["?t", "project", projVar]] } };
}

// ---------------------------------------------------------------------------
// Row-level visibility. Stardust does NOT do authorization (auth only proves
// identity for attribution) — so visibility is an app predicate the server
// injects using the viewer's persona. A todo is visible if it's published
// (draft:false) OR the viewer is its author.
//
// This is an expression-`or` over BOUND scalar fields (bind draft/author first,
// then predicate) — the one shape Stardust's `or` supports. It's join-free so it
// paginates cleanly, and `{#viewer}` is injected server-side, so hidden rows
// never cross the wire. Every todo must carry draft+author for the binding
// clauses to match (addTodo sets them; migrateVisibilityFields backfills).
// ---------------------------------------------------------------------------
export function visibleTo(personaId: number): unknown[][] {
  return [
    ["?t", "draft", "?draft"],
    ["?t", "author", "?author"],
    ["or", ["=", "?draft", false], ["=", "?author", { "#": personaId }]],
  ];
}
