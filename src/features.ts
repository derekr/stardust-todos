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
import { type Status, effectiveStatusOf, refreshDerived } from "./todos.ts";

/** Confirm a todo id belongs to this workspace before writing an edge to it.
 *  Returns the entity, so a caller that also needs its fields reads it once. */
async function assertOwned(ctx: WorkspaceCtx, id: EntityId): Promise<Record<string, unknown>> {
  const e = await readEntity(id);
  if ((e.workspace as { "#": EntityId } | undefined)?.["#"] !== ctx.workspaceId) {
    throw new Error(`todo ${id} is not in workspace ${ctx.workspaceId}`);
  }
  return e;
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
  const t = await assertOwned(ctx, todoId);
  const b = await assertOwned(ctx, blockerId); // both ends must be in this workspace
  // Invariant, enforced at the write boundary: you can't depend on a todo you
  // can't SEE (someone else's draft). So the "blocked by a hidden draft" state
  // is unrepresentable — no read-time repair needed. (Publish is one-way, so a
  // linked todo can't later become private.)
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
  // The edge and its consequence in ONE transaction. No query is needed to know
  // the consequence: an edge to a not-done blocker can only turn `blocked` ON, and
  // we have already read the blocker to check visibility. An edge to a finished
  // blocker changes nothing, and the patch is omitted rather than written as a
  // no-op — which is what keeps "a dep edge was added" and "this todo became
  // blocked" the same fact-level event when it is true, and absent when it is not.
  const patch: Record<string, Record<string, unknown>> = {
    "#_e": { kind: "dep", todo: { "#": todoId }, blocker: { "#": blockerId } },
  };
  if (b.status !== "done") {
    const effectiveStatus = effectiveStatusOf((t.status ?? "todo") as Status, true);
    if (t.blocked !== true || t.effectiveStatus !== effectiveStatus) {
      patch[todoId] = { blocked: true, effectiveStatus };
    }
  }
  await transact(patch);
}

/** Retracting an edge can only turn `blocked` OFF — but only if no OTHER open
 *  blocker remains, which is a question for the query. `deleteEntity` is a DELETE,
 *  not a patch, so the consequence cannot ride along with it and lands in the
 *  transaction immediately after. */
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
  if (!rows.length) return;
  await Promise.all(rows.map(([id]) => deleteEntity(id)));
  await refreshDerived([todoId]);
}

// ---- Derived views (all workspace-scoped) --------------------------------
