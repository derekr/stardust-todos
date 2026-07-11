// Advanced todo features that were NOT designed up front — added later as the
// app's needs grew, leaning on Stardust idioms:
//
//   tags          many-to-many, modeled as `tag` EDGE entities (not an inline
//                 array) so membership is a real query and single tags add/remove.
//   dependencies  `dep` EDGE entities (todo, blocker) — a graph over todos.
//   due dates     Stardust instants ({#utc ...}) with field predicates for overdue.
//   status        an enum scalar on the todo.
//
// Every read here is workspace-scoped through scopedTodo(ctx): the join always
// pins [?t workspace {# id}], so no feature query can leak across tenants.

import type { WorkspaceCtx } from "./workspace.ts";
import type { EntityId } from "./stardust.ts";
import { APP } from "./tenancy.ts";
import { deleteEntity, query, readEntity, transact } from "./stardust.ts";
import { query as tquery } from "./typed-query.ts";
import { openBlockerClause } from "./derive.ts";

export interface TodoRow {
  id: EntityId;
  title: string;
}

/** The one scoping fragment every feature query prepends. Returned as a const
 *  tuple so it can be spread into a tquery `where` and stay compile-checked. */
function scopedTodo(ctx: WorkspaceCtx) {
  return [
    ["?t", "app", APP],
    ["?t", "workspace", { "#": ctx.workspaceId }],
    ["?t", "title", "?title"],
  ] as const;
}

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

export async function removeTag(ctx: WorkspaceCtx, todoId: EntityId, label: string): Promise<void> {
  await assertOwned(ctx, todoId);
  const rows = await tquery({
    find: ["?e"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", { "#": todoId }],
      ["?e", "label", label],
    ],
  } as const); // ?e subject-position → id; rows: [number][]
  await Promise.all(rows.map(([id]) => deleteEntity(id))); // retract the edge
}

/** Todos in this workspace carrying `label`. */
export async function todosByTag(ctx: WorkspaceCtx, label: string): Promise<TodoRow[]> {
  // Stardust shapes the row: `then.project` returns {id, title} objects — no
  // in-app tuple mapping — and normalizes ?t to a numeric id even though it sits
  // in a ref position in the tag join. The boundary validator checks both fields.
  return tquery({
    find: ["?t", "?title"],
    where: [...scopedTodo(ctx), ["?e", "kind", "tag"], ["?e", "todo", "?t"], ["?e", "label", label]],
    orderBy: ["?title"],
    then: { project: { id: "?t", title: "?title" } },
  } as const);
}

export async function tagsOf(ctx: WorkspaceCtx, todoId: EntityId): Promise<string[]> {
  const rows = await tquery({
    find: ["?label"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", { "#": todoId }],
      ["?e", "label", "?label"],
    ],
    orderBy: ["?label"],
    then: { project: { label: "?label" } }, // shaped + validated by Stardust
  } as const);
  return rows.map((r) => r.label);
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

/** Todos with a due date strictly before `nowIso`, not yet done. */
export async function overdue(ctx: WorkspaceCtx, nowIso: string): Promise<TodoRow[]> {
  return tquery({
    find: ["?t", "?title"],
    where: [
      ...scopedTodo(ctx),
      ["?t", "status", "?status"],
      ["!=", "?status", "done"],
      ["?t", "due", "?due"],
      ["<", "?due", { "#utc": nowIso }],
    ],
    orderBy: ["?due"],
    then: { project: { id: "?t", title: "?title" } }, // predicates checked; row shaped by Stardust
  } as const);
}

/**
 * Todos blocked by a dependency whose blocker is not yet done — ONE query via
 * the correlated `exists` subquery. `exists` yields one row per matching todo, so
 * a todo with several incomplete blockers appears once: no JS dedupe needed.
 * (Raw `query`, not tquery: the typed-query checker only models 3-tuple clauses,
 * so `exists`/`notExists` verbs go through raw query — same reason board.ts does.)
 */
export async function blocked(ctx: WorkspaceCtx): Promise<TodoRow[]> {
  return (await query({
    find: ["?t", "?title"],
    where: [...scopedTodo(ctx), openBlockerClause("?t", false)],
    orderBy: ["?title"],
    then: { project: { id: "?t", title: "?title" } }, // Stardust normalizes ?t to a numeric id
  })) as TodoRow[];
}

/**
 * Ready = status "todo" AND not blocked — ONE query via the correlated
 * `notExists` subquery. The bare `not` verb can't express this (it needs its vars
 * bound and doesn't compose over a multi-clause join — and an `or(owned, not …)`
 * scope was verified to LEAK across tenants), but a captured `notExists` subquery
 * correlates per-row correctly. This replaces the old two-query + JS set-difference.
 */
export async function ready(ctx: WorkspaceCtx): Promise<TodoRow[]> {
  return (await query({
    find: ["?t", "?title"],
    where: [...scopedTodo(ctx), ["?t", "status", "todo"], openBlockerClause("?t", true)],
    orderBy: ["?title"],
    then: { project: { id: "?t", title: "?title" } },
  })) as TodoRow[];
}
