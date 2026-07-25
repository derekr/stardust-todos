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

/** An OPEN blocker exists for ?t. Same predicate as derive.ts openBlockerExists,
 *  in the form a reactor needs: bound to a var so `cond`/`project` can use it,
 *  rather than the `$exists` directive a dry-run projection takes. */
const OPEN_BLOCKER = {
  capture: { t: "?t" },
  find: ["?e"],
  where: [
    ["?e", "kind", "dep"],
    ["?e", "todo", "?t"],
    ["?e", "blocker", "?b"],
    ["?b", "status", "?bs"],
    ["!=", "?bs", "done"],
  ],
} as const;

/** Status + priority of every viewer-visible todo, with blocked derived per row.
 *  The effective-status tally is folded app-side (blocked is not a stored field). */
export const counts = define("board-counts", {
  find: ["?t", "?status", "?priority"],
  where: [
    ["?t", "app", APP],
    ["?t", "workspace", "?ws"],
    ["?t", "status", "?status"],
    ["?t", "priority", "?priority"],
    ...VISIBLE,
    // bind the correlated exists to a var, then project the var — inlining a bare
    // `exists` into an expression runs it UNCORRELATED (true for every row).
    [["exists", OPEN_BLOCKER], "?blocked"],
  ],
  then: { project: { status: "?status", priority: "?priority", blocked: "?blocked" } },
} as const);

/** Every dependency edge in the workspace: todo -> blocker (+ its title/status). */
export const blockers = define("board-blockers", {
  find: ["?t", "?b", "?bt", "?bs"],
  where: [
    ["?d", "kind", "dep"],
    ["?d", "todo", "?t"],
    ["?t", "workspace", "?ws"],
    ["?d", "blocker", "?b"],
    ["?b", "title", "?bt"],
    ["?b", "status", "?bs"],
  ],
  then: { project: { todo: "?t", blocker: "?b", title: "?bt", status: "?bs" } },
} as const);

/** Distinct tag labels in use across the workspace (deduped by the caller). */
export const workspaceTags = define("board-tags", {
  find: ["?label"],
  where: [
    ["?e", "kind", "tag"],
    ["?e", "todo", "?t"],
    ["?t", "workspace", "?ws"],
    ["?e", "label", "?label"],
  ],
  orderBy: ["?label"],
  then: { project: { label: "?label" } },
} as const);

/** Viewer-visible todos as pickable options (the dependency picker). */
export const todoPicker = define("todo-options", {
  find: ["?t", "?title"],
  where: [["?t", "app", APP], ["?t", "workspace", "?ws"], ["?t", "title", "?title"], ...VISIBLE],
  orderBy: ["?title"],
  then: { project: { id: "?t", title: "?title" } },
} as const);

/** The tags on ONE todo. */
export const tagsOfTodo = define("todo-tags", {
  find: ["?label"],
  where: [
    ["?e", "kind", "tag"],
    ["?e", "todo", "?todo"],
    ["?e", "label", "?label"],
  ],
  orderBy: ["?label"],
  then: { project: { label: "?label" } },
} as const);

/** Titles of the todos that depend on ONE todo (the reverse dependency edge). */
export const blockedByTodo = define("todo-blocks", {
  find: ["?bt"],
  where: [
    ["?d", "kind", "dep"],
    ["?d", "blocker", "?todo"],
    ["?d", "todo", "?t"],
    ["?t", "title", "?bt"],
  ],
  then: { project: { title: "?bt" } },
} as const);

// ---------------------------------------------------------------------------
// Commands. The role gate is IN the query: both reactors below take `?rank` and
// compare it against each command's `minRank`, so "may this persona run this"
// is answered by Stardust rather than reconstructed in TypeScript afterwards.
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

/** Commands of ONE scope that a rank may SEE, ordered — the ⌘K palette and the
 *  per-todo ••• menu are this one reactor read with a different bind.
 *
 *  `visible` is `enabled || showWhenDenied`: a command the persona cannot run
 *  still appears greyed when it is meant to advertise itself, and vanishes
 *  entirely otherwise. Both the filter and the ordering are the engine's.
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

/** ONE command, returned only if this rank may RUN it — the write boundary.
 *
 *  Not scoped: a cmdId names one command wherever it lives. A denied command and
 *  an unknown one are both the empty result, which is exactly the distinction the
 *  caller already declined to make. */
const commandAuthz = define("command-authz", {
  find: ["?cmdId", "?label", "?minRank", "?showWhenDenied", "?danger", "?scope", "?order"],
  where: [
    ["?c", "kind", "command"],
    ["?c", "cmdId", "?cmdId"],
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
 * unreachable. `?rank` now fails closed on its own, but `?scope` and `?cmdId` are
 * fact-clause vars and still do not: omit `?scope` and you get both scopes,
 * omit `?cmdId` and you get every command the rank allows — ordered, and looking
 * perfectly healthy. A missing function argument is the same mistake the
 * compiler catches for free.
 */
export const commandMenuRows = (scope: Scope, rank: number) => commandMenu.read({ scope, rank });
export const commandAuthzRows = (cmdId: string, rank: number) => commandAuthz.read({ cmdId, rank });

/** Everything `npm run stardust:setup` provisions, besides the board reactor. */
export const DECLARED = [
  counts,
  blockers,
  workspaceTags,
  todoPicker,
  tagsOfTodo,
  blockedByTodo,
  commandMenu,
  commandAuthz,
] as const;
