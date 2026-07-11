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
import type { Status } from "./todos.ts";
import { APP } from "./tenancy.ts";
import { deleteEntity, query, readEntity, transact } from "./stardust.ts";

export interface TodoRow {
  id: EntityId;
  title: string;
}

/** The one scoping fragment every feature query prepends. */
function scopedTodo(ctx: WorkspaceCtx): unknown[][] {
  return [
    ["?t", "app", APP],
    ["?t", "workspace", { "#": ctx.workspaceId }],
    ["?t", "title", "?title"],
  ];
}

const asId = (v: unknown): EntityId => (typeof v === "number" ? v : (v as { "#": EntityId })["#"]);

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
  const existing = await query({
    find: ["?e"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", { "#": todoId }],
      ["?e", "label", label],
    ],
    limit: 1,
  });
  if (existing.length) return;
  await transact({ "#_e": { kind: "tag", todo: { "#": todoId }, label } });
}

export async function removeTag(ctx: WorkspaceCtx, todoId: EntityId, label: string): Promise<void> {
  await assertOwned(ctx, todoId);
  const rows = (await query({
    find: ["?e"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", { "#": todoId }],
      ["?e", "label", label],
    ],
  })) as [EntityId][];
  await Promise.all(rows.map(([id]) => deleteEntity(id))); // retract the edge
}

/** Todos in this workspace carrying `label`. */
export async function todosByTag(ctx: WorkspaceCtx, label: string): Promise<TodoRow[]> {
  const rows = (await query({
    find: ["?t", "?title"],
    where: [
      ...scopedTodo(ctx),
      ["?e", "kind", "tag"],
      ["?e", "todo", "?t"],
      ["?e", "label", label],
    ],
    orderBy: ["?title"],
  })) as [EntityId, string][];
  return rows.map(([id, title]) => ({ id: asId(id), title }));
}

export async function tagsOf(ctx: WorkspaceCtx, todoId: EntityId): Promise<string[]> {
  const rows = (await query({
    find: ["?label"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", { "#": todoId }],
      ["?e", "label", "?label"],
    ],
    orderBy: ["?label"],
  })) as [string][];
  return rows.map(([l]) => l);
}

// ---- Dependencies (edge entities) ----------------------------------------

export async function addDependency(ctx: WorkspaceCtx, todoId: EntityId, blockerId: EntityId): Promise<void> {
  if (todoId === blockerId) return; // no self-dependency
  await assertOwned(ctx, todoId);
  await assertOwned(ctx, blockerId); // both ends must be in this workspace
  // idempotent
  const existing = await query({
    find: ["?e"],
    where: [["?e", "kind", "dep"], ["?e", "todo", { "#": todoId }], ["?e", "blocker", { "#": blockerId }]],
    limit: 1,
  });
  if (existing.length) return;
  await transact({ "#_e": { kind: "dep", todo: { "#": todoId }, blocker: { "#": blockerId } } });
}

export async function removeDependency(ctx: WorkspaceCtx, todoId: EntityId, blockerId: EntityId): Promise<void> {
  await assertOwned(ctx, todoId);
  const rows = (await query({
    find: ["?e"],
    where: [["?e", "kind", "dep"], ["?e", "todo", { "#": todoId }], ["?e", "blocker", { "#": blockerId }]],
  })) as [EntityId][];
  await Promise.all(rows.map(([id]) => deleteEntity(id)));
}

// ---- Derived views (all workspace-scoped) --------------------------------

/** Todos with a due date strictly before `nowIso`, not yet done. */
export async function overdue(ctx: WorkspaceCtx, nowIso: string): Promise<TodoRow[]> {
  const rows = (await query({
    find: ["?t", "?title"],
    where: [
      ...scopedTodo(ctx),
      ["?t", "status", "?status"],
      ["!=", "?status", "done"],
      ["?t", "due", "?due"],
      ["<", "?due", { "#utc": nowIso }],
    ],
    orderBy: ["?due"],
  })) as [EntityId, string][];
  return rows.map(([id, title]) => ({ id: asId(id), title }));
}

/** Todos blocked by a dependency whose blocker is not yet done. */
export async function blocked(ctx: WorkspaceCtx): Promise<TodoRow[]> {
  const rows = (await query({
    find: ["?t", "?title"],
    where: [
      ...scopedTodo(ctx),
      ["?d", "kind", "dep"],
      ["?d", "todo", "?t"],
      ["?d", "blocker", "?b"],
      ["?b", "status", "?bs"],
      ["!=", "?bs", "done"],
    ],
    orderBy: ["?title"],
  })) as [EntityId, string][];
  // a todo may have several incomplete blockers -> dedupe
  const seen = new Map<EntityId, string>();
  for (const [id, title] of rows) seen.set(asId(id), title);
  return [...seen].map(([id, title]) => ({ id, title }));
}

/**
 * Ready = status "todo" AND not blocked. Stardust's `not` doesn't compose over
 * a multi-clause join (and or/not was shown to leak), so we take the safe route:
 * two positive queries and a set difference. This is orchestration, not a guard.
 */
export async function ready(ctx: WorkspaceCtx): Promise<TodoRow[]> {
  const todoRows = (await query({
    find: ["?t", "?title"],
    where: [...scopedTodo(ctx), ["?t", "status", "todo"]],
    orderBy: ["?title"],
  })) as [EntityId, string][];
  const blockedIds = new Set((await blocked(ctx)).map((r) => r.id));
  return todoRows.map(([id, title]) => ({ id: asId(id), title })).filter((r) => !blockedIds.has(r.id));
}
