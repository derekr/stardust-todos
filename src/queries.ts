// The app's declared reactors — one definition each, typed accessors out.
//
// These were per-render dry-runs: a detail page fired eight of them, each planned
// and executed from scratch. As stored reactors they are maintained incrementally
// by Stardust and read back with a per-call BIND, so one reactor serves every
// workspace, viewer and todo instead of one query execution per render.
//
// Everything a caller used to pass as a literal (`{"#": ctx.workspaceId}`) is now
// a var the reader binds. Note the asymmetry that creates: Stardust rejects a bind
// var NAME it does not know (`unknown bind var ?scoop`), but never an ABSENT bind —
// an unbound var matches everything, so a caller who forgets `ws` gets the whole
// database back, ordered, looking perfectly healthy. Every read below passes its
// scope; where the over-broad answer would be an AUTHORIZATION answer the
// `Declared` is not exported at all, and the only reader takes the scope as a
// required argument (see `commandsInScope`).

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

/** Every command entity of ONE scope, ordered — the ⌘K palette and the per-todo
 *  ••• menu are the same reactor read with a different bind.
 *
 *  `?scope` is deliberately absent from `find`: the reader supplies it, so the row
 *  is exactly a `CommandDef` minus its scope. It stays an ordinary top-level
 *  clause, which is what makes a NEW command entity push to a subscriber bound to
 *  that scope — and to that scope only (measured; see AGENTS.md). Nothing
 *  subscribes today, the menus read per render, but the shape is what would make
 *  a live catalog free. */
const commandCatalog = define("command-catalog", {
  find: ["?cmdId", "?label", "?minRank", "?showWhenDenied", "?danger", "?order"],
  where: [
    ["?c", "kind", "command"],
    ["?c", "scope", "?scope"],
    ["?c", "cmdId", "?cmdId"],
    ["?c", "label", "?label"],
    ["?c", "minRank", "?minRank"],
    ["?c", "showWhenDenied", "?showWhenDenied"],
    ["?c", "danger", "?danger"],
    ["?c", "order", "?order"],
  ],
  orderBy: ["?order"],
} as const);

/**
 * The catalog of one scope. The scope is a required ARGUMENT, not a bind the
 * caller assembles, and that is the whole guard: the reactor above is unexported,
 * so there is no way to reach `.read({})`.
 *
 * Why bother, when every other reader here just passes a bind — because this one
 * feeds `authorizeCommand`, and Stardust will not complain. A misspelled bind var
 * is an error; an OMITTED one is not. It simply leaves `?scope` free, and the
 * reactor then returns every command in BOTH scopes, in order, looking entirely
 * healthy. A missing function argument is the same mistake the compiler catches.
 */
export const commandsInScope = (scope: Scope) => commandCatalog.read({ scope });

/** Everything `npm run stardust:setup` provisions, besides the board reactor. */
export const DECLARED = [
  counts,
  blockers,
  workspaceTags,
  todoPicker,
  tagsOfTodo,
  blockedByTodo,
  commandCatalog,
] as const;
