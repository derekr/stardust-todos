// The app's declared reactors — one definition each, typed accessors out.
//
// These were per-render dry-runs: a detail page fired eight of them, each planned
// and executed from scratch. As stored reactors they are maintained incrementally
// by Stardust and read back with a per-call BIND, so one reactor serves every
// workspace, viewer and todo instead of one query execution per render.
//
// Everything a caller used to pass as a literal (`{"#": ctx.workspaceId}`) is now
// a var the reader binds. Note the asymmetry that creates: Stardust rejects a bind
// var NAME it does not know (`unknown bind var ?scoop`), but usually not an ABSENT
// one — a var a FACT CLAUSE would bind matches everything instead, so a caller who
// forgets `ws` gets the whole database back, ordered, looking perfectly healthy.
// The exception is a var read by an EXPRESSION, which cannot widen the answer: it
// errors, or returns a subset if no row ever reaches the predicate (see the
// command reactors below, and AGENTS.md for the measured limits). Every read here
// passes its scope regardless; where the over-broad answer would be an
// AUTHORIZATION answer the `Declared` is not exported at all and the reader takes
// its scope as a required argument.

import type { Scope } from "./commands.ts";
import { visibleTo } from "./derive.ts";
import { define } from "./reactors.ts";
import { APP } from "./tenancy.ts";

/** The one visibility rule, with the viewer left as a per-read bind. */
const VISIBLE = visibleTo("?viewer");

// `board-blockers` used to live here and is gone: it read EVERY dependency edge in
// the workspace to draw ⊘ badges on fifty rows. Its replacement asks for the ids on
// the page (`blockersFor`), which is a set literal that varies per read, so it is a
// dry-run for the same reason the board's rows are.
//
// `board-counts` left too, and CAME BACK — which makes it the one entry in this
// file worth reading twice, because the measurement that removed it is still true
// and no longer decides the question. Per READ a bind is a real price: the same
// counts body is 197ms through the stored reactor with `?ws`/`?viewer` and 132ms as
// a dry-run with both spelled as literals, because a value the planner has when it
// plans is one it can narrow on. That is why it was inlined. It is also PER READ,
// and the whole point of putting it back is to stop reading it — a subscription
// pays the bind once at subscribe and every push after it is free. The trade did
// not get re-litigated; the read it was about stopped existing.

/**
 * Every viewer-visible todo in one workspace, grouped by (effectiveStatus,
 * priority) — the numbers on the filter chips, the sidebar and the total pill.
 *
 * Held open by counts.ts rather than read per render, which is the only reason it
 * is stored: a fixed body whose two inputs are both binds is exactly what this file
 * is for, and a bind is what buys a SUBSCRIPTION — the one thing no literal can.
 *
 * Every clause is TOP-LEVEL, which is what makes the push reliable, and it was
 * verified rather than assumed (this app has twice been caught by an emission that
 * never came). On a throwaway, two subscriptions on this one reactor bound to two
 * personas, written to from a separate process: a status write moved the tally, a
 * new todo appeared in it, completing a blocker moved the `blocked` group and the
 * target group in ONE emission, a retraction moved it back, a title-only write
 * pushed nothing at all, and a draft authored by one persona woke that persona's
 * subscription and NOT the other's. Five writes, five emissions, in order.
 *
 * It is NOT narrowed by the board's filter, and must not be: the chips answer "how
 * many would you get if you picked this". That is also what makes a subscription
 * the right shape — nothing a reader does can change these numbers, so a render has
 * no business asking.
 */
export const boardCounts = define("board-counts", {
  find: ["?eff", "?priority", ["count", "?t"]],
  where: [
    ["?t", "app", APP],
    ["?t", "workspace", "?ws"],
    ["?t", "effectiveStatus", "?eff"],
    ["?t", "priority", "?priority"],
    ...VISIBLE,
  ],
  groupBy: ["?eff", "?priority"],
} as const);

/** The blockers OF one todo, walked from the todo end: bound by `?todo`, so the
 *  detail page reads the handful of rows it renders instead of every edge in the
 *  workspace. A fixed body and one bind — which is what still belongs in here. */
export const blockersOfTodo = define("todo-blockers", {
  find: ["?b", "?bt", "?bs"],
  where: [
    ["?d", "kind", "dep"],
    ["?d", "todo", "?todo"],
    ["?d", "blocker", "?b"],
    ["?b", "title", "?bt"],
    ["?b", "status", "?bs"],
  ],
  then: { project: { blocker: "?b", title: "?bt", status: "?bs" } },
} as const);

/**
 * The rows one open stream has on screen, joined back from its `pg` facts.
 *
 * Bound by `?ps` — a REF to the page-set entity, which a bind does accept where a
 * list of fifty ids does not. One definition serves every open stream. This is the
 * ONE place a stored reactor is unambiguously right: it is a subscription, its cost
 * is bounded by the page size rather than the workspace, and membership changes
 * only when the app rewrites the page-set — so a reader is woken by edits to what
 * they are looking at and by nothing else.
 */
export const pageRows = define("page-rows", {
  find: ["?t", "?title", "?status", "?priority", "?eff", "?blocked", "?done"],
  where: [
    ["?p", "kind", "pg"],
    ["?p", "pgset", "?ps"],
    ["?p", "todo", "?t"],
    ["?t", "title", "?title"],
    ["?t", "status", "?status"],
    ["?t", "priority", "?priority"],
    ["?t", "effectiveStatus", "?eff"],
    ["?t", "blocked", "?blocked"],
    ["?t", "done", "?done"],
  ],
  then: {
    project: {
      id: "?t",
      title: "?title",
      status: "?status",
      priority: "?priority",
      effectiveStatus: "?eff",
      blocked: "?blocked",
      done: "?done",
    },
  },
} as const);

/**
 * Distinct tag labels in use across the workspace — an aggregate over every tag
 * edge in it.
 *
 * NOTHING ON A PAGE READS THIS ANY MORE, and the reason it is still here is the
 * point of the change that removed it: the vocabulary is a fact on the workspace
 * entity now (`tagVocab`, tags.ts), because it changes when a label is first used
 * or last removed and otherwise never, while this body cost 29.5ms of every board
 * render to answer the same ten rows. What a materialised fact needs is a guard,
 * and this is the guard's question — `reconcileTagVocabulary` compares the stored
 * list against what this returns, and the write paths consult it to find out
 * whether a label they just removed had any edge left behind it.
 *
 * It stays a stored reactor with a `?ws` bind rather than becoming a dry-run
 * because it is still one fixed body whose only input is a scope, which is this
 * file's whole test — and because the x-ray hands it to a reader with a bind, which
 * a dry-run cannot be.
 */
export const workspaceTags = define("board-tags", {
  find: ["?label", ["count", "?e"]],
  where: [
    ["?e", "kind", "tag"],
    ["?e", "todo", "?t"],
    ["?t", "workspace", "?ws"],
    ["?e", "label", "?label"],
  ],
  groupBy: ["?label"],
  orderBy: ["?label"],
} as const);

/** How many candidates the unsearched picker offers. Exported because the render
 *  has to know whether the list it is holding is the whole answer or the top of
 *  one — a truncation the page says out loud rather than hiding. */
export const PICKER_LIMIT = 25;

/** Viewer-visible todos as pickable options (the dependency picker). */
/**
 * Candidates for "add a blocker" — the FIRST PAGE of them, not all of them.
 *
 * This used to return every visible todo in the workspace, and the detail page
 * rendered one button per row. At ten thousand todos that was a 686KB read taking
 * 307ms of a 361ms page, to build a list of 9,947 buttons nobody can use. The cost
 * and the UX were the same bug: an unbounded read behind a small control.
 *
 * `limit` is deliberately larger than the list shown, because the caller drops the
 * todo itself and anything already blocking it before rendering.
 *
 * What this reactor is NOT is the picker's search. It answers "what does the list
 * open on", which is a fixed body with two binds, so it stays here. Typing in the
 * search box asks a different question — "which titles contain this word" — with a
 * different clause and a different order, and a search term cannot travel as a
 * bind (see `searchTodoOptions` in board.ts for why), so that one is a dry-run
 * built per read. The rule this file has followed since the board left it holds:
 * a stored reactor fits a body that is fixed and inputs that can all be binds.
 */
export const todoPicker = define("todo-options", {
  find: ["?t", "?title"],
  where: [["?t", "app", APP], ["?t", "workspace", "?ws"], ["?t", "title", "?title"], ...VISIBLE],
  orderBy: ["?title"],
  limit: PICKER_LIMIT,
  then: { project: { id: "?t", title: "?title" } },
} as const);

/**
 * The tags on ONE todo.
 *
 * The BACKLINK leads, and the order of these three clauses is worth 4x on a read
 * that returns two rows. `[?e kind tag]` is a scan of every tag edge in the
 * database — thousands of them — and `[?e todo {# id}]` is a backlink that returns
 * the two this todo has; written the other way round the engine builds the big set
 * first and then filters it, because it evaluates a `where` in the order it is
 * given and does not reorder. Measured on the demo, same two labels in the same
 * order: 16.0ms with `kind` first, 6.2ms with the backlink first, and 5.0ms with
 * `kind` dropped entirely.
 *
 * It is NOT dropped, because `kind` is this app's cheap insurance against a future
 * entity carrying the same field shape (see AGENTS.md) — but insurance belongs
 * after the clause that makes the question small, not in front of it. This is the
 * same rule board-query.ts is built around, on a body a thousand times smaller: put
 * the clause that narrows where the read starts.
 */
export const tagsOfTodo = define("todo-tags", {
  find: ["?label"],
  where: [
    ["?e", "todo", "?todo"],
    ["?e", "kind", "tag"],
    ["?e", "label", "?label"],
  ],
  orderBy: ["?label"],
  then: { project: { label: "?label" } },
} as const);

/** The todos that depend on ONE todo (the reverse dependency edge).
 *
 *  The detail page wants the titles; the write path wants the IDS, because these
 *  are exactly the rows whose stored `blocked` a status write to `?todo` changes
 *  (`dependentsOf` in todos.ts). `?t` is bound in subject position by the title
 *  clause, so it projects as a bare id rather than a ref. */
export const blockedByTodo = define("todo-blocks", {
  find: ["?t", "?bt"],
  where: [
    ["?d", "kind", "dep"],
    ["?d", "blocker", "?todo"],
    ["?d", "todo", "?t"],
    ["?t", "title", "?bt"],
  ],
  then: { project: { id: "?t", title: "?bt" } },
} as const);

// ---------------------------------------------------------------------------
// Commands. BOTH halves of "may this persona run this, on this thing" are IN the
// query: the reactors below take `?rank` and compare it against each command's
// `minRank`, and they take `?state` and test it against the command's `appliesTo`.
// So neither the role rule nor the applicability rule is reconstructed in
// TypeScript afterwards.
//
// `?rank` is read by an expression, and that changes the bind hazard for these
// two specifically. An ordinary fact clause BINDS its var by scanning, so an
// omitted bind silently matches everything; an expression predicate only filters
// rows that already exist, so it cannot invent `?rank` and the read fails with
// `unbound input var ?rank`. The gate therefore fails CLOSED, which is the
// property a write boundary wants.
//
// Precisely: that error is raised when the predicate is EVALUATED, so it needs a
// candidate row to reach it. Here one always does — the catalog is seeded at
// startup, and an empty catalog would return no commands to authorize anyway — but
// the general rule is weaker than "an absent bind always errors". It is "an absent
// expression-only bind never widens the answer". See AGENTS.md for where that
// distinction bites (`visibleTo`).
//
// `?state` is the second half of the same shape, and it is what stopped a DONE todo
// offering "Mark complete". Which states a command applies to is a fact on the
// command — `appliesTo`, a list — and the test is an expression over it:
//
//   ["?c", "appliesTo", "?applies"],
//   ["any", ["fn", ["s"], ["=", "s", "?state"]], "?applies"]
//
// The lambda CAPTURES the outer bind (measured — the interesting result, since
// nothing documents it), so one stored body serves every state, and an omitted
// `?state` fails exactly the way an omitted `?rank` does: `unbound input var
// ?state`, never a superset. That is why applicability lives here rather than in
// the renderer — `command-authz` gets the same two clauses, so a command the menu
// would not have shown is REFUSED at the write boundary rather than merely hidden.
//
// A disjunction of fact patterns would have been the obvious way to write this and
// is a constant `true` (see derive.ts); `contains` wants a `{#set}` LITERAL, which a
// stored body cannot vary per read. A list component plus `any` is the shape that
// is left, and it is the one tags.ts already uses.

/** Commands of ONE scope that a rank may SEE on a thing in ONE state, ordered —
 *  the ⌘K palette and the per-todo ••• menu are this one reactor read with a
 *  different bind.
 *
 *  `visible` is `enabled || showWhenDenied`: a command the persona cannot run
 *  still appears greyed when it is meant to advertise itself, and vanishes
 *  entirely otherwise. Both the filter and the ordering are the engine's.
 *
 *  Applicability is not the same kind of rule as the rank, and the difference is
 *  why it filters instead of projecting: a command that does not apply is not
 *  denied, it is MEANINGLESS here, so there is no greyed-out form of it and no
 *  copy to write. "Mark complete" and "Reopen todo" are the demonstration — they
 *  carry the same `order` because they can never both apply.
 *
 *  `?minRank` stays in `find` even though the gate already used it, because the
 *  DENIAL COPY is derived from it app-side ("Owner only" vs "Members only").
 *  That copy is UI text and deliberately does not live in the reactor.
 *
 *  `?scope` is an ordinary top-level clause, which is what makes a NEW command
 *  entity push to a subscriber bound to that scope — and to that scope only
 *  (measured; see AGENTS.md). Nothing subscribes today, the menus read per
 *  render, but the shape is what would make a live catalog free. */
const commandMenu = define("command-menu", {
  find: ["?cmdId", "?label", "?minRank", "?enabled", "?danger", "?order"],
  where: [
    ["?c", "kind", "command"],
    ["?c", "scope", "?scope"],
    ["?c", "appliesTo", "?applies"],
    ["any", ["fn", ["s"], ["=", "s", "?state"]], "?applies"],
    ["?c", "minRank", "?minRank"],
    ["?c", "showWhenDenied", "?showWhenDenied"],
    [[">=", "?rank", "?minRank"], "?enabled"],
    [["or", "?enabled", "?showWhenDenied"], "?visible"],
    ["=", "?visible", true],
    ["?c", "cmdId", "?cmdId"],
    ["?c", "label", "?label"],
    ["?c", "danger", "?danger"],
    ["?c", "order", "?order"],
  ],
  orderBy: ["?order"],
} as const);

/** ONE command, returned only if this rank may RUN it ON A THING IN THIS STATE —
 *  the write boundary.
 *
 *  Not scoped: a cmdId names one command wherever it lives. A denied command, an
 *  inapplicable one and an unknown one are all the empty result, which is exactly
 *  the distinction the caller already declined to make.
 *
 *  The applicability clauses are the SAME two the menu has, in the same order, and
 *  that is the whole point: `todo.complete` posted for a done todo returns nothing
 *  here, so hiding it in the menu and refusing it on the write are one rule read
 *  twice rather than two rules that can drift. */
const commandAuthz = define("command-authz", {
  find: ["?cmdId", "?label", "?minRank", "?showWhenDenied", "?danger", "?scope", "?order", "?applies"],
  where: [
    ["?c", "kind", "command"],
    ["?c", "cmdId", "?cmdId"],
    ["?c", "appliesTo", "?applies"],
    ["any", ["fn", ["s"], ["=", "s", "?state"]], "?applies"],
    ["?c", "minRank", "?minRank"],
    [">=", "?rank", "?minRank"],
    ["?c", "label", "?label"],
    ["?c", "showWhenDenied", "?showWhenDenied"],
    ["?c", "danger", "?danger"],
    ["?c", "scope", "?scope"],
    ["?c", "order", "?order"],
  ],
} as const);

/**
 * Both readers take their scope as required ARGUMENTS rather than a bind the
 * caller assembles, and the `Declared`s above are unexported so `.read({})` is
 * unreachable. `?rank` and `?state` now fail closed on their own, but `?scope` and
 * `?cmdId` are fact-clause vars and still do not: omit `?scope` and you get both
 * scopes, omit `?cmdId` and you get every command the rank allows — ordered, and
 * looking perfectly healthy. A missing function argument is the same mistake the
 * compiler catches for free.
 *
 * `state` is a string here rather than a union because its domain is the union of
 * two: a todo's `status` and the one state a workspace has. `stateOf` in
 * commands.ts is the only thing that builds one, and it is where that is checked.
 */
export const commandMenuRows = (scope: Scope, rank: number, state: string) => commandMenu.read({ scope, rank, state });
export const commandAuthzRows = (cmdId: string, rank: number, state: string) =>
  commandAuthz.read({ cmdId, rank, state });

/** Everything `npm run stardust:setup` provisions, besides the board reactor. */
export const DECLARED = [
  boardCounts,
  workspaceTags,
  todoPicker,
  tagsOfTodo,
  blockedByTodo,
  blockersOfTodo,
  pageRows,
  commandMenu,
  commandAuthz,
] as const;
