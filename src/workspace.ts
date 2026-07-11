// WorkspaceCtx: the capability that unlocks todo access.
//
// The ONLY way to get one is openWorkspace(), which runs the grant check
// first. Because every todo read/write in todos.ts requires a WorkspaceCtx,
// there is no code path that touches todos without having passed access
// control — the type system makes "forgot to check the tenant" unrepresentable.

import type { EntityId } from "./stardust.ts";
import {
  assertAccess,
  createPersona,
  createWorkspace,
  ensureUser,
  listPersonas,
  listWorkspaces,
  workspaceReactor,
} from "./tenancy.ts";
import { ensureTodoSchema, migrateOrphanTodos } from "./todos.ts";

/** An access-checked handle to one workspace. Holds no client-supplied filter. */
export interface WorkspaceCtx {
  readonly personaId: EntityId;
  readonly workspaceId: EntityId;
  readonly reactorId: EntityId;
}

/** Open a workspace as a persona. Throws AccessDenied without a grant. */
export async function openWorkspace(personaId: EntityId, workspaceId: EntityId): Promise<WorkspaceCtx> {
  await assertAccess(personaId, workspaceId); // <-- the gate
  const reactorId = await workspaceReactor(workspaceId);
  return { personaId, workspaceId, reactorId };
}

const DEFAULT_EMAIL = "default@local";
const DEFAULT_NAME = "Default";

/**
 * Bootstrap a single default tenant so the CLI and web UI keep working with no
 * login. Idempotent via lookups.
 *
 * On FIRST creation it backfills legacy single-tenant todos (app-tagged, no
 * workspace) into the default workspace with migrateOrphanTodos. That is a
 * genuine migration — but a cheap one: it only ASSERTS a `workspace` fact per
 * row (additive, non-destructive, history-preserving, reversible), never an
 * ALTER TABLE. We do it because the safe isolation boundary is a single pinned
 * clause; the "adopt legacy rows at read-time via or/not" shortcut was tested
 * and leaks, so legacy data must actually be assigned a workspace.
 */
export async function defaultWorkspace(): Promise<WorkspaceCtx> {
  await ensureTodoSchema();

  const userId = await ensureUser(DEFAULT_EMAIL);
  const personaId =
    (await listPersonas(userId)).find((p) => p.name === DEFAULT_NAME)?.id ??
    (await createPersona(userId, DEFAULT_NAME));

  let ws = (await listWorkspaces(personaId)).find((w) => w.name === DEFAULT_NAME);
  if (!ws) {
    ws = await createWorkspace(personaId, DEFAULT_NAME);
    const ctx = { personaId, workspaceId: ws.id, reactorId: ws.reactorId };
    const n = await migrateOrphanTodos(ctx);
    if (n) console.error(`(backfilled ${n} legacy todo(s) into the default workspace)`);
  }
  return { personaId, workspaceId: ws.id, reactorId: ws.reactorId };
}
