// Derive-on-read directives — the declarative replacement for the imperative
// workflow worker.
//
// Each is a CORRELATED `$exists` subquery for a reactor/query `then.project`.
// It's evaluated once per projected row (the `capture` map binds the outer var
// into the subquery — keys omit the leading "?"), and it's 0-safe: a row with
// no match still appears, projected as `false`.
//
// Why this eliminates the worker: blocked-ness is computed on every READ, so it
// never needs to be written back OR undone. The one thing
// Stardust can't do — reactively drive a join-derived state BACK when the
// condition ceases (no correlated antijoin in `where`, no reactor auto-retract)
// — simply never comes up, because nothing is materialized in the first place.

/**
 * The correlated "open blocker" subquery — "≥1 dependency on a not-done blocker",
 * correlated on `todoVar` via `capture`. This is the `$exists` PROJECTION form,
 * used by dry-runs; src/queries.ts carries the same predicate in the bind-to-a-var
 * form a reactor needs. (A bare fact `not`/multi-clause join can't express this; only a
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
export function visibleTo(viewer: number | string): unknown[][] {
  // A persona id pins the viewer into the query (dry-runs); a "?var" leaves it to
  // be supplied per read, which is how a STORED reactor serves every viewer.
  const who = typeof viewer === "number" ? { "#": viewer } : viewer;
  return [
    ["?t", "draft", "?draft"],
    ["?t", "author", "?author"],
    ["or", ["=", "?draft", false], ["=", "?author", who]],
  ];
}
