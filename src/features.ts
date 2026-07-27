// Todo features that were NOT designed up front — added later as the app's needs
// grew, leaning on Stardust idioms:
//
//   tags          many-to-many, modeled as `tag` EDGE entities so membership is a
//                 real query and a label is data — PLUS a `tags` list component on
//                 the todo itself, written by the same transaction as the edge,
//                 which is what the board filters on (see tags.ts for why).
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
import { canonicalTags, tagLabel } from "./tags.ts";
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

/**
 * Add a label to a todo: the EDGE and the todo's own `tags` component, in ONE
 * transaction.
 *
 * The same rule the derived fields follow — the transaction that causes a change
 * records the consequence — and for the same reason: the board matches on the
 * component, and a row whose component was never written is not a row that sorts
 * oddly, it is a row that disappears from a filtered board.
 *
 * The EDGES are the source of truth for what the component should say, so the new
 * value is computed from them rather than from the component being replaced. That
 * makes this self-healing: adding a label a todo already carries still rewrites the
 * component, which repairs a todo whose edges and component had drifted apart.
 *
 * It also replaces the existence probe this used to open with. A repeat add is
 * `unchanged:1` at the engine (2ms, no facts), so idempotence is the store's job
 * rather than a query's — the only reason to look first is to know whether the EDGE
 * needs creating, and `tagsOf` answers that as a side effect of the value it is
 * already fetching.
 */
export async function addTag(ctx: WorkspaceCtx, todoId: EntityId, label: string): Promise<void> {
  await assertOwned(ctx, todoId);
  const l = tagLabel(label);
  const current = await tagsOf(ctx, todoId);
  const patch: Record<string, Record<string, unknown>> = { [todoId]: { tags: canonicalTags([...current, l]) } };
  if (!current.includes(l)) patch["#_e"] = { kind: "tag", todo: { "#": todoId }, label: l };
  await transact(patch);
}

/**
 * Remove a label from a todo: the edge entities carrying it, then the component.
 *
 * `deleteEntity` is a DELETE rather than a patch, so the consequence cannot ride
 * along with its cause and lands in the transaction immediately after — the same
 * shape (and the same reason) as `removeDependency`. The component is rewritten
 * from what the edges said BEFORE the delete, minus this label, so it does not
 * depend on the delete having been observed by a subsequent read.
 */
export async function removeTag(ctx: WorkspaceCtx, todoId: EntityId, label: string): Promise<void> {
  await assertOwned(ctx, todoId);
  const l = tagLabel(label);
  const edges = await tquery({
    find: ["?e"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", { "#": todoId }],
      ["?e", "label", l],
    ],
  } as const); // ?e subject-position → id; rows: [number][]
  const current = await tagsOf(ctx, todoId);
  if (!edges.length && !current.includes(l)) return;
  await Promise.all(edges.map(([id]) => deleteEntity(id)));
  const rest = canonicalTags(current.filter((x) => x !== l));
  // `null` retracts the field; an EMPTY array would write an empty list, which is a
  // fact asserting "no tags" rather than the absence of one — and would then match
  // the board's `[?t tags ?tags]` clause for nothing.
  await transact({ [todoId]: { tags: rest.length ? rest : null } });
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
