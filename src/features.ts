// Todo features that were NOT designed up front — added later as the app's needs
// grew, leaning on Stardust idioms:
//
//   tags          many-to-many, modeled as `tag` EDGE entities (not an inline
//                 array) so membership is a real query and single tags add/remove.
//   dependencies  `dep` EDGE entities (todo, blocker) — a graph over todos.
//
// Tenant safety here is a WRITE guard, not a query shape: assertOwned() reads the
// todo and refuses if it is not in this workspace, so no edge can ever be created
// pointing at another tenant's todo. The reads below are keyed by a todo id the
// caller already obtained through a workspace-scoped path, so they inherit that
// scoping rather than re-pinning [?t workspace {# id}] themselves.

import type { WorkspaceCtx } from "./workspace.ts";
import type { EntityId } from "./stardust.ts";
import { deleteEntity, readEntity, transact } from "./stardust.ts";
import { query as tquery } from "./typed-query.ts";
import { tagsOfTodo } from "./queries.ts";

/** Confirm a todo id belongs to this workspace before writing an edge to it. */
async function assertOwned(ctx: WorkspaceCtx, id: EntityId): Promise<void> {
  const e = await readEntity(id);
  if ((e.workspace as { "#": EntityId } | undefined)?.["#"] !== ctx.workspaceId) {
    throw new Error(`todo ${id} is not in workspace ${ctx.workspaceId}`);
  }
}

// ---- Tags (edge entities) ------------------------------------------------

export async function addTag(ctx: WorkspaceCtx, todoId: EntityId, label: string): Promise<void> {
  await assertOwned(ctx, todoId);
  // idempotent: only create the edge if it doesn't already exist
  const existing = await tquery({
    find: ["?e"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", { "#": todoId }],
      ["?e", "label", label],
    ],
    limit: 1,
  } as const);
  if (existing.length) return;
  await transact({ "#_e": { kind: "tag", todo: { "#": todoId }, label } });
}

export async function tagsOf(ctx: WorkspaceCtx, todoId: EntityId): Promise<string[]> {
  const rows = await tagsOfTodo.read({ todo: { "#": todoId } });
  return rows.map((r) => r.label as string);
}

// ---- Dependencies (edge entities) ----------------------------------------

export async function addDependency(
  ctx: WorkspaceCtx,
  todoId: EntityId,
  blockerId: EntityId,
  actingPersonaId: EntityId = ctx.personaId,
): Promise<void> {
  if (todoId === blockerId) return; // no self-dependency
  await assertOwned(ctx, todoId);
  await assertOwned(ctx, blockerId); // both ends must be in this workspace
  // Invariant, enforced at the write boundary: you can't depend on a todo you
  // can't SEE (someone else's draft). So the "blocked by a hidden draft" state
  // is unrepresentable — no read-time repair needed. (Publish is one-way, so a
  // linked todo can't later become private.)
  const b = await readEntity(blockerId);
  const visibleToActor = b.draft === false || (b.author as { "#": EntityId } | undefined)?.["#"] === actingPersonaId;
  if (!visibleToActor) throw new Error(`todo ${blockerId} is a draft you don't own — cannot depend on it`);
  // idempotent
  const existing = await tquery({
    find: ["?e"],
    where: [
      ["?e", "kind", "dep"],
      ["?e", "todo", { "#": todoId }],
      ["?e", "blocker", { "#": blockerId }],
    ],
    limit: 1,
  } as const);
  if (existing.length) return;
  await transact({ "#_e": { kind: "dep", todo: { "#": todoId }, blocker: { "#": blockerId } } });
}

export async function removeDependency(ctx: WorkspaceCtx, todoId: EntityId, blockerId: EntityId): Promise<void> {
  await assertOwned(ctx, todoId);
  const rows = await tquery({
    find: ["?e"],
    where: [
      ["?e", "kind", "dep"],
      ["?e", "todo", { "#": todoId }],
      ["?e", "blocker", { "#": blockerId }],
    ],
  } as const); // ?e subject-position → id; rows: [number][]
  await Promise.all(rows.map(([id]) => deleteEntity(id)));
}

// ---- Derived views (all workspace-scoped) --------------------------------
