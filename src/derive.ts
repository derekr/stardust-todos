// The query fragments the reads share — one definition, injected everywhere.
//
// This file used to be the derive-on-read catalog: correlated `$exists`
// subqueries, evaluated once per projected row, that replaced an imperative
// workflow worker. The shape worked; the claim that came with it did not.
// "Computed on every READ, so it never needs writing back" is true and was still
// the wrong trade for `blocked`, because a correlated subquery is executed PER ROW
// against a 10,000-execution budget shared by the whole query — so the board did
// not degrade above a few thousand todos, it failed outright. That derivation moved
// to the WRITE path and is stored (todos.ts, `refreshDerived`); the board and the
// counts reactor now JOIN `blocked`/`effectiveStatus`/`prank` instead of computing
// them, and the correlated open-blocker fragment that lived here is gone with them.
//
// The one derivation that can never move to a write is `overdue`, and it is not
// here either: it compares against `now`, so no write is ever the moment it
// changes, and it is plain clauses with `now` as a per-read BIND in the board's
// overdue body (session.ts). What is left is visibility, which is not derived from
// the graph at all — it is a predicate over two fields of the row itself.

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
//
// "The one shape `or` supports" is exact, and the tag filter is what proved it. An
// `or` whose branches are FACT PATTERNS — `[or [?t tag/design true] [?t tag/launch
// true]]` — is not rejected and is not a disjunction: a pattern is a three-element
// list, a list is truthy, so the clause is a constant `true` and the query returns
// every row it would have returned with no clause at all (9,948 of 9,948, measured).
// Stardust has no or-join over patterns at all; a membership test over one bound
// value is the shape to reach for, which is what tags.ts does with `contains`.
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
