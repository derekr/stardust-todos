// A data-driven command catalog.
//
// Commands are Stardust ENTITIES (kind:"command"), not hardcoded UI, and the role
// gate is a clause in the query rather than a pass over the results. Two reactors
// share it: `command-menu` returns what a rank may SEE (contextual menu, toolbar,
// ⌘K palette) and `command-authz` returns a command only if that rank may RUN it.
// So the menu you see and the mutation you're allowed cannot drift — they compare
// the same `minRank` the same way — and changing access is a fact write, not a
// deploy.
//
// What remains on this side is the role HIERARCHY (any < member < owner) and the
// denial copy. The hierarchy is the more interesting leftover: while the app turns
// a role into a rank, "who may do what" is still partly TypeScript. Making ranks
// facts would finish the job, and is why `roleRank` is the only logic here.

import { commandAuthzRows, commandMenuRows } from "./queries.ts";
import type { Role } from "./tenancy.ts";
import { query as tquery } from "./typed-query.ts";

// role hierarchy: any(0) < member(1) < owner(2)
const roleRank = (role: Role | null): number => (role === "owner" ? 2 : role === "member" ? 1 : 0);

export type Scope = "global" | "todo";

export interface CommandDef {
  cmdId: string;
  label: string;
  minRank: number; // 0 any · 1 member · 2 owner
  showWhenDenied: boolean; // show grayed with a reason, vs hide entirely
  danger: boolean;
  scope: Scope;
  order: number;
}

/**
 * A command as a menu renders it — deliberately NOT `CommandDef` plus flags.
 *
 * There is no `visible` field because the query no longer returns rows this
 * persona may not see, so nothing downstream has a visibility test to forget.
 * `minRank`, `showWhenDenied` and `order` are gone for the same reason: they are
 * inputs to a decision Stardust has already made.
 */
export interface ProjectedCommand {
  cmdId: string;
  label: string;
  enabled: boolean;
  danger: boolean;
  reason: string; // why it is disabled; "" when enabled
}

/**
 * The commands of a scope this role may SEE, ordered, already projected.
 *
 * This began as a dry-run over both scopes plus a `.filter()`, then became a
 * scoped reactor plus a `project()` pass. Both halves are now the `command-menu`
 * reactor read with `?scope` and `?rank` bound: the rank comparison, the
 * visibility rule and the ordering all happen in the engine, and what comes back
 * is already the rows this persona is allowed to see.
 *
 * What stays here is the part that is not a fact about access: `reason` is UI
 * copy, so it is derived from `minRank` on this side rather than embedded in a
 * stored query where changing a string would be a reactor patch.
 */
export async function visibleCommands(scope: Scope, role: Role | null): Promise<ProjectedCommand[]> {
  const rows = await commandMenuRows(scope, roleRank(role));
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
 *  `command-authz` returns the command only when `?rank` clears its `minRank`, so
 *  this no longer reads a catalog and re-derives the verdict — an empty result IS
 *  the denial. Unknown and denied are both empty, which is the distinction this
 *  function never made anyway.
 *
 *  The gate cannot be bypassed by forgetting the bind: `?rank` is read by an
 *  expression, so an absent bind fails the read outright instead of matching
 *  every row (measured; see AGENTS.md). */
export async function authorizeCommand(cmdId: string, role: Role | null): Promise<CommandDef | null> {
  const rows = await commandAuthzRows(cmdId, roleRank(role));
  const row = rows[0];
  if (!row) return null; // denied or unknown — indistinguishable, by design
  const [id, label, minRank, showWhenDenied, danger, scope, order] = row;
  return { cmdId: id, label, minRank, showWhenDenied, danger, scope: scope as Scope, order };
}

/** Seed the catalog + a member persona (idempotent). Returns nothing. */
export async function ensureCommandCatalog(): Promise<void> {
  const existing = await tquery({ find: ["?c"], where: [["?c", "kind", "command"]], limit: 1 } as const);
  if (existing.length) return;
  const { transact } = await import("./stardust.ts");
  const cmd = (
    cmdId: string,
    label: string,
    minRank: number,
    showWhenDenied: boolean,
    danger: boolean,
    scope: Scope,
    order: number,
  ) => ({ kind: "command", cmdId, label, minRank, showWhenDenied, danger, scope, order });
  await transact({
    // global (toolbar + palette)
    "#_c1": cmd("workspace.invite", "Invite member", 2, true, false, "global", 1),
    "#_c2": cmd("workspace.export", "Export CSV", 1, false, false, "global", 2),
    "#_c3": cmd("workspace.rename", "Rename workspace", 2, true, false, "global", 3),
    "#_c4": cmd("workspace.archive", "Archive workspace", 2, true, true, "global", 4),
    // per-todo (contextual menu + palette)
    "#_c5": cmd("todo.complete", "Mark complete", 0, false, false, "todo", 1),
    "#_c6": cmd("todo.duplicate", "Duplicate todo", 1, false, false, "todo", 2),
    "#_c7": cmd("todo.delete", "Delete todo", 2, false, true, "todo", 3),
  });
}
