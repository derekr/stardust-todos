// A data-driven command catalog.
//
// Commands are Stardust ENTITIES (kind:"command"), not hardcoded UI. A single
// projection turns the catalog + the current persona's role into per-command
// state {visible, enabled, reason}. The SAME projection feeds every surface
// (contextual menu, toolbar button, command palette) AND the write boundary —
// so the menu you see and the mutation you're allowed can never drift, and
// changing access is a fact write, not a deploy.

import type { Role } from "./tenancy.ts";
import { type EntityId, query } from "./stardust.ts";

// role hierarchy: any(0) < member(1) < owner(2)
export const roleRank = (role: Role | null): number => (role === "owner" ? 2 : role === "member" ? 1 : 0);

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

export interface ProjectedCommand extends CommandDef {
  enabled: boolean;
  visible: boolean;
  reason: string;
}

/** All command entities of a scope, ordered. */
export async function catalog(scope: Scope): Promise<CommandDef[]> {
  const rows = (await query({
    find: ["?cmdId", "?label", "?minRank", "?showWhenDenied", "?danger", "?scope", "?order"],
    where: [
      ["?c", "kind", "command"],
      ["?c", "cmdId", "?cmdId"],
      ["?c", "label", "?label"],
      ["?c", "minRank", "?minRank"],
      ["?c", "showWhenDenied", "?showWhenDenied"],
      ["?c", "danger", "?danger"],
      ["?c", "scope", "?scope"],
      ["?c", "order", "?order"],
    ],
    orderBy: ["?order"],
  })) as [string, string, number, boolean, boolean, Scope, number][];
  return rows
    .map(([cmdId, label, minRank, showWhenDenied, danger, s, order]) => ({
      cmdId,
      label,
      minRank,
      showWhenDenied,
      danger,
      scope: s,
      order,
    }))
    .filter((c) => c.scope === scope);
}

/** Project the catalog for one role: compute visible/enabled/reason. */
export function project(cmds: CommandDef[], role: Role | null): ProjectedCommand[] {
  const rank = roleRank(role);
  return cmds
    .map((c) => {
      const enabled = rank >= c.minRank;
      const reason = enabled ? "" : c.minRank >= 2 ? "Owner only" : "Members only";
      return { ...c, enabled, visible: enabled || c.showWhenDenied, reason };
    })
    .filter((c) => c.visible);
}

/** The write-boundary check — reads the SAME catalog + role. */
export async function authorizeCommand(cmdId: string, role: Role | null): Promise<CommandDef | null> {
  const all = [...(await catalog("global")), ...(await catalog("todo"))];
  const c = all.find((x) => x.cmdId === cmdId);
  if (!c || roleRank(role) < c.minRank) return null; // denied or unknown
  return c;
}

/** Seed the catalog + a member persona (idempotent). Returns nothing. */
export async function ensureCommandCatalog(): Promise<void> {
  const existing = await query({ find: ["?c"], where: [["?c", "kind", "command"]], limit: 1 });
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
