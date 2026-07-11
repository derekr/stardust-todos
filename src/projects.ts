// Projects: a grouping layer inside a workspace (workspace -> project -> todo).
// Also the showpiece Stardust idiom: DUPLICATE a project — clone the project,
// its todos, and the dependency + tag EDGES between them, remapping every ref
// to the new copies in ONE atomic transaction using temp-id references.

import type { WorkspaceCtx } from "./workspace.ts";
import { type EntityId, type MergePatch, query, readEntity, refId, transact } from "./stardust.ts";
import { query as tquery } from "./typed-query.ts";
import { APP } from "./tenancy.ts";
import { anyTodoExists, openTodoExists } from "./derive.ts";

export interface Project {
  id: EntityId;
  name: string;
  status: string;
}

export async function createProject(ctx: WorkspaceCtx, name: string): Promise<EntityId> {
  const r = await transact({
    "#_p": { kind: "project", workspace: { "#": ctx.workspaceId }, name, status: "active" },
  });
  return r.tempIds!.p;
}

export async function listProjects(ctx: WorkspaceCtx): Promise<Project[]> {
  const rows = (await query({
    find: ["?p", "?name"],
    where: [
      ["?p", "kind", "project"],
      ["?p", "workspace", { "#": ctx.workspaceId }],
      ["?p", "name", "?name"],
    ],
    orderBy: ["?name"],
    then: {
      project: {
        id: "?p",
        name: "?name",
        hasOpen: openTodoExists("?p"), // ≥1 not-done todo
        hasAny: anyTodoExists("?p"), // ≥1 todo at all
      },
    },
  })) as { id: EntityId; name: string; hasOpen: boolean; hasAny: boolean }[];
  // Project status is DERIVED (rollup), computed on read via correlated $exists:
  // "done" only when the project has todos and none are open; else "active". No
  // stored rollup, no worker — this replaces the old C/D workflow rules.
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.hasAny && !r.hasOpen ? "done" : "active" }));
}

export async function projectTodos(ctx: WorkspaceCtx, projectId: EntityId): Promise<{ id: EntityId; title: string }[]> {
  // Stardust projects the {id, title} shape directly (no in-app tuple mapping),
  // and the boundary validator checks each field.
  return tquery({
    find: ["?t", "?title"],
    where: [
      ["?t", "app", APP],
      ["?t", "workspace", { "#": ctx.workspaceId }],
      ["?t", "project", { "#": projectId }],
      ["?t", "title", "?title"],
    ],
    orderBy: ["?title"],
    then: { project: { id: "?t", title: "?title" } },
  } as const);
}

/**
 * Duplicate a project as a fresh copy (progress reset). Reads the project's
 * todos plus the dependency and tag edges among them, then writes the whole
 * graph in ONE transaction: temp ids `#_p`, `#_t<oldId>`, etc., with refs like
 * `{ "#": "_t<oldId>" }` so Stardust rewires every dependency/tag to the NEW
 * todos atomically. No dangling cross-project references are possible.
 */
export async function duplicateProject(ctx: WorkspaceCtx, projectId: EntityId, newName: string): Promise<EntityId> {
  const proj = await readEntity(projectId);
  if ((proj.workspace as { "#": EntityId } | undefined)?.["#"] !== ctx.workspaceId) {
    throw new Error(`project ${projectId} is not in workspace ${ctx.workspaceId}`);
  }

  const todos = await projectTodos(ctx, projectId);
  const todoIds = new Set(todos.map((t) => t.id));

  // dependency edges whose todo side is in this project
  const deps = (await query({
    find: ["?tt", "?bb"],
    where: [
      ["?d", "kind", "dep"],
      ["?d", "todo", "?tt"],
      ["?tt", "project", { "#": projectId }],
      ["?d", "blocker", "?bb"],
    ],
  })) as [{ "#": EntityId }, { "#": EntityId }][];

  // tag edges on this project's todos
  const tags = (await query({
    find: ["?tt", "?label"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", "?tt"],
      ["?tt", "project", { "#": projectId }],
      ["?e", "label", "?label"],
    ],
  })) as [{ "#": EntityId }, string][];

  const tmp = (id: EntityId) => `_t${id}`; // deterministic temp id per old todo
  const patch: Record<string, MergePatch<Record<string, unknown>>> = {
    "#_p": { kind: "project", workspace: { "#": ctx.workspaceId }, name: newName, status: "active" },
  };

  // clone todos (fresh progress), rewire project -> new project temp id
  for (const t of todos) {
    const src = await readEntity(t.id);
    patch[`#${tmp(t.id)}`] = {
      app: APP,
      workspace: { "#": ctx.workspaceId },
      project: { "#": "_p" },
      title: src.title as string,
      priority: (src.priority as string) ?? "med",
      status: "todo",
      done: false,
      ...(src.due ? { due: src.due } : {}),
    };
  }

  // clone dependency edges, remapping BOTH ends to the new todos
  let i = 0;
  for (const [tt, bb] of deps) {
    const a = refId(tt);
    const b = refId(bb);
    if (!todoIds.has(a) || !todoIds.has(b)) continue; // only intra-project edges
    patch[`#_d${i++}`] = { kind: "dep", todo: { "#": tmp(a) }, blocker: { "#": tmp(b) } };
  }

  // clone tag edges
  let j = 0;
  for (const [tt, label] of tags) {
    const a = refId(tt);
    if (!todoIds.has(a)) continue;
    patch[`#_g${j++}`] = { kind: "tag", todo: { "#": tmp(a) }, label };
  }

  const r = await transact(patch);
  return r.tempIds!.p;
}
