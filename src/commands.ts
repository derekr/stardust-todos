// A data-driven command catalog.
//
// Commands are Stardust ENTITIES (kind:"command"), not hardcoded UI, and the rules
// about them are CLAUSES in the query rather than a pass over the results. Two
// reactors share those clauses: `command-menu` returns what a rank may SEE on a
// thing in a given state (contextual menu, toolbar, ⌘K palette) and `command-authz`
// returns a command only if that rank may RUN it on a thing in that state. So the
// menu you see and the mutation you're allowed cannot drift — they compare the same
// `minRank` and the same `appliesTo` the same way — and changing access, or which
// states an action makes sense in, is a fact write rather than a deploy.
//
// There are two rules, and they are different kinds of rule. `minRank` is
// PERMISSION: the command means something here, you may not have it, so a denied
// one can still be advertised greyed with a reason. `appliesTo` is APPLICABILITY:
// completing a done todo is not forbidden, it is meaningless, so an inapplicable
// command has no greyed form and no copy — it simply is not in the menu. That is
// why one is projected (`?enabled` comes back and the app writes the reason beside
// it) and the other only filters.
//
// What remains on this side is the role HIERARCHY (any < member < owner) and the
// denial copy. The hierarchy is the more interesting leftover: while the app turns
// a role into a rank, "who may do what" is still partly TypeScript. Making ranks
// facts would finish the job, and is why `roleRank` is the only logic here.

import { commandAuthzRows, commandMenuRows } from "./queries.ts";
import type { Role } from "./tenancy.ts";
import type { Status } from "./todos.ts";
import { query as tquery } from "./typed-query.ts";

// role hierarchy: any(0) < member(1) < owner(2)
const roleRank = (role: Role | null): number => (role === "owner" ? 2 : role === "member" ? 1 : 0);

export type Scope = "global" | "todo";

/**
 * The state a workspace is in — the one value `?state` takes for a global command.
 *
 * A global command's subject is the workspace, which has no status, so it needs a
 * state to be applicable TO or the same clause cannot serve both scopes. Spelling
 * it `global` rather than inventing a wildcard is deliberate: a wildcard would be a
 * second rule in the predicate ("this state, OR the one that matches everything"),
 * and the whole point of putting applicability in the clause was to have one rule.
 */
const WORKSPACE_STATE = "global";

/**
 * The states a todo can be in, for applicability purposes — its `status`, NOT its
 * `effectiveStatus`.
 *
 * This is the decision worth arguing with, so here is the argument. The two differ
 * on exactly one thing: a todo with an open blocker has `effectiveStatus:"blocked"`
 * while its `status` is still `todo` or `doing`. Keying on `status` means such a
 * todo is offered "Mark complete" without `blocked` appearing in any list, which is
 * right — being blocked is a fact about a todo's DEPENDENCIES, not about whether
 * completing it is a meaningful thing to ask for. Keying on `effectiveStatus` would
 * mean every command that applies to an in-progress todo has to remember to list
 * `blocked` as well, and forgetting it would hide the command on blocked todos —
 * silently, which is the exact class of bug this predicate exists to remove.
 *
 * The other half: `status` is the field these commands WRITE, so applicability and
 * effect are spelled in one vocabulary. `status` is user INTENT and never holds
 * `blocked` (`migrateBlockedStatus` in todos.ts is what guarantees that), so this
 * is the whole domain.
 */
const TODO_STATES = ["todo", "doing", "done"] as const;

/**
 * What a command is being offered ON. A todo-scoped menu cannot be asked for
 * without a status, because the type has nowhere to put the question.
 *
 * This is the same guard `scope` gets in queries.ts and for the same reason: the
 * bind those readers need is not one a caller should be assembling by hand, and a
 * missing function argument is the mistake the compiler catches for free.
 */
export type CommandTarget = { scope: "global" } | { scope: "todo"; status: Status };

/** The `?state` bind a target implies — the only thing that builds one. */
const stateOf = (target: CommandTarget): string => (target.scope === "global" ? WORKSPACE_STATE : target.status);

export interface CommandDef {
  cmdId: string;
  label: string;
  minRank: number; // 0 any · 1 member · 2 owner
  showWhenDenied: boolean; // show grayed with a reason, vs hide entirely
  danger: boolean;
  scope: Scope;
  order: number;
  /** the states this command applies to — todo `status` values, or `global` */
  appliesTo: readonly string[];
}

/**
 * The seeded catalog. Data, not code: every row here is a set of facts, and the
 * only thing this array does is put them there the first time.
 *
 * `todo.complete` and `todo.reopen` share `order` 1 on purpose. They are the same
 * slot in the menu seen from either side of `done`, and they can never both apply,
 * so the ordering never has to separate them — which is the clearest statement that
 * applicability is a partition of the catalog rather than a filter on top of it.
 */
export const CATALOG: readonly CommandDef[] = [
  // global (toolbar + palette) — the workspace's one state
  {
    cmdId: "workspace.invite",
    label: "Invite member",
    minRank: 2,
    showWhenDenied: true,
    danger: false,
    scope: "global",
    order: 1,
    appliesTo: [WORKSPACE_STATE],
  },
  {
    cmdId: "workspace.export",
    label: "Export CSV",
    minRank: 1,
    showWhenDenied: false,
    danger: false,
    scope: "global",
    order: 2,
    appliesTo: [WORKSPACE_STATE],
  },
  {
    cmdId: "workspace.rename",
    label: "Rename workspace",
    minRank: 2,
    showWhenDenied: true,
    danger: false,
    scope: "global",
    order: 3,
    appliesTo: [WORKSPACE_STATE],
  },
  {
    cmdId: "workspace.archive",
    label: "Archive workspace",
    minRank: 2,
    showWhenDenied: true,
    danger: true,
    scope: "global",
    order: 4,
    appliesTo: [WORKSPACE_STATE],
  },
  // per-todo (contextual menu + palette)
  {
    cmdId: "todo.complete",
    label: "Mark complete",
    minRank: 0,
    showWhenDenied: false,
    danger: false,
    scope: "todo",
    order: 1,
    appliesTo: ["todo", "doing"],
  },
  {
    cmdId: "todo.reopen",
    label: "Reopen todo",
    minRank: 0,
    showWhenDenied: false,
    danger: false,
    scope: "todo",
    order: 1,
    appliesTo: ["done"],
  },
  {
    cmdId: "todo.duplicate",
    label: "Duplicate todo",
    minRank: 1,
    showWhenDenied: false,
    danger: false,
    scope: "todo",
    order: 2,
    appliesTo: TODO_STATES,
  },
  {
    cmdId: "todo.delete",
    label: "Delete todo",
    minRank: 2,
    showWhenDenied: false,
    danger: true,
    scope: "todo",
    order: 3,
    appliesTo: TODO_STATES,
  },
];

/**
 * A command as a menu renders it — deliberately NOT `CommandDef` plus flags.
 *
 * There is no `visible` field because the query no longer returns rows this
 * persona may not see, and no `appliesTo` because it no longer returns rows that
 * do not apply here. `minRank`, `showWhenDenied` and `order` are gone for the same
 * reason: they are inputs to a decision Stardust has already made.
 */
export interface ProjectedCommand {
  cmdId: string;
  label: string;
  enabled: boolean;
  danger: boolean;
  reason: string; // why it is disabled; "" when enabled
}

/**
 * The commands this role may SEE on this target, ordered, already projected.
 *
 * This began as a dry-run over both scopes plus a `.filter()`, then became a
 * scoped reactor plus a `project()` pass. Both halves are now the `command-menu`
 * reactor read with `?scope`, `?rank` and `?state` bound: the rank comparison, the
 * state test, the visibility rule and the ordering all happen in the engine, and
 * what comes back is already the rows this persona is allowed to see on this thing.
 *
 * What stays here is the part that is not a fact about access: `reason` is UI
 * copy, so it is derived from `minRank` on this side rather than embedded in a
 * stored query where changing a string would be a reactor patch. Note that there
 * is no reason copy for applicability and there should not be — an inapplicable
 * command never reaches this function.
 */
export async function visibleCommands(target: CommandTarget, role: Role | null): Promise<ProjectedCommand[]> {
  const rows = await commandMenuRows(target.scope, roleRank(role), stateOf(target));
  return rows.map(([cmdId, label, minRank, row, danger]) => {
    // `?enabled` is an expression result, not a schema field, so the row type
    // cannot infer it. Narrow rather than assert: anything but a literal true
    // renders as denied, which is the safe direction for a permission flag.
    const enabled = row === true;
    return {
      cmdId,
      label,
      enabled,
      danger,
      reason: enabled ? "" : minRank >= 2 ? "Owner only" : "Members only",
    };
  });
}

/** The write-boundary check: the authorization decision IS the query.
 *
 *  `command-authz` returns the command only when `?rank` clears its `minRank` AND
 *  `?state` is one of its `appliesTo`, so this no longer reads a catalog and
 *  re-derives the verdict — an empty result IS the refusal. Unknown, denied and
 *  inapplicable are all empty, which is the distinction this function never made
 *  anyway.
 *
 *  The applicability half is the reason this takes a target rather than a bare
 *  cmdId: `todo.complete` POSTed for a todo that is already done is REFUSED here,
 *  not merely absent from the menu that would have offered it. An app-side check in
 *  the renderer would have left this path open.
 *
 *  Neither gate can be bypassed by forgetting the bind: `?rank` and `?state` are
 *  both read by expressions, so an absent bind fails the read outright instead of
 *  matching every row (measured; see AGENTS.md). */
export async function authorizeCommand(
  cmdId: string,
  target: CommandTarget,
  role: Role | null,
): Promise<CommandDef | null> {
  const rows = await commandAuthzRows(cmdId, roleRank(role), stateOf(target));
  const row = rows[0];
  if (!row) return null; // denied, inapplicable or unknown — indistinguishable, by design
  const [id, label, minRank, showWhenDenied, danger, scope, order, appliesTo] = row;
  return { cmdId: id, label, minRank, showWhenDenied, danger, scope: scope as Scope, order, appliesTo };
}

/**
 * Make the catalog exist, per COMMAND rather than per catalog (idempotent).
 *
 * This used to be "if any command entity exists, do nothing", which was fine while
 * the catalog never grew and wrong the moment it did: `todo.reopen` would have been
 * a fact write nobody performed, on every database seeded before it was written. It
 * reconciles by `cmdId` now, so adding a row to `CATALOG` reaches an existing
 * database on the next boot — which is what "adding a command is a fact write, not
 * a deploy" has to mean for a database that is already running.
 *
 * It also BACKFILLS `appliesTo` onto commands seeded before applicability existed,
 * in the style of the `migrate*` functions in todos.ts: a fact clause names it now,
 * and a row that has never been written a field a clause names is skipped in
 * silence — which for this reactor means an empty ••• menu rather than an error.
 *
 * What it deliberately does NOT do is overwrite an `appliesTo` that is already
 * there and disagrees with this file. Changing when a command applies without a
 * deploy is exactly the property the design claims; a boot that reverted such a
 * write would take it away again.
 */
export async function ensureCommandCatalog(): Promise<{ added: number; backfilled: number }> {
  const [existing, applicable] = await Promise.all([
    tquery({
      find: ["?c", "?cmdId"],
      where: [
        ["?c", "kind", "command"],
        ["?c", "cmdId", "?cmdId"],
      ],
    } as const),
    tquery({
      find: ["?cmdId"],
      where: [
        ["?c", "kind", "command"],
        ["?c", "cmdId", "?cmdId"],
        ["?c", "appliesTo", "?applies"],
      ],
    } as const),
  ]);
  const idOf = new Map(existing.map(([id, cmdId]) => [cmdId, id]));
  const hasApplies = new Set(applicable.map(([cmdId]) => cmdId));

  const patch: Record<string, Record<string, unknown>> = {};
  let added = 0;
  let backfilled = 0;
  for (const c of CATALOG) {
    const id = idOf.get(c.cmdId);
    if (id === undefined) {
      patch[`#_${c.cmdId.replace(/\W/g, "_")}`] = { kind: "command", ...c, appliesTo: [...c.appliesTo] };
      added++;
    } else if (!hasApplies.has(c.cmdId)) {
      patch[String(id)] = { appliesTo: [...c.appliesTo] };
      backfilled++;
    }
  }
  if (added || backfilled) {
    const { transact } = await import("./stardust.ts");
    await transact(patch);
  }
  return { added, backfilled };
}
