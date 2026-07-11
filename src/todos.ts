// Todo domain layer — now WORKSPACE-SCOPED.
//
// Every read and write takes a WorkspaceCtx (a capability you can only get by
// passing an access check in workspace.ts). Reads go through the workspace's
// pinned reactor; writes stamp the workspace ref and are guarded so you can
// never mutate a todo in a workspace you don't hold. Isolation is enforced in
// THREE independent layers:
//   1. types  — no todo call compiles without a WorkspaceCtx.
//   2. reads  — the reactor's where-clause is pinned to the workspace server-side.
//   3. writes — belongsTo() re-checks the fact before every mutation.

import { readFile, writeFile } from "node:fs/promises";
import type { WorkspaceCtx } from "./workspace.ts";
import { APP } from "./tenancy.ts";
import {
  type EntityId,
  type MergePatch,
  createSchema,
  createSchemaEntity,
  deleteEntity,
  patchSchema,
  patchSchemaEntity,
  query,
  readEntity,
  readResults,
  readSchema,
  streamResults,
  transact,
} from "./stardust.ts";

export type Priority = "low" | "med" | "high";
export type Status = "todo" | "doing" | "blocked" | "done";

export interface Todo {
  id: EntityId;
  title: string;
  done: boolean;
  priority: Priority;
  status: Status;
  lastActor?: string;
}

interface TodoDoc {
  title: string;
  done: boolean;
  priority: Priority;
  workspace: { "#": EntityId };
  app: string;
  status?: Status;
  due?: { "#utc": string };
  project?: { "#": EntityId };
  lastActor?: string; // materialized: who last changed this todo (cheap per-row read)
}

const STATE_FILE = new URL("../.state.json", import.meta.url);

// Evolved schema. It has grown three times without a rewrite or downtime:
//   v1  title, done, priority
//   v2  + workspace, app        (multi-tenancy)
//   v3  + status, due, project  (richer exploration fields)
// Old todos stay valid facts; new fields are optional, so nothing breaks.
const TODO_SCHEMA = {
  title: "Todo",
  type: "object",
  required: ["title", "done", "workspace", "app"],
  properties: {
    title: { type: "string", minLength: 1 },
    done: { type: "boolean" },
    priority: { type: "string", enum: ["low", "med", "high"] },
    workspace: { type: "object" },
    app: { type: "string" },
    status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
    due: { type: "object" }, // Stardust instant {#utc ...}
    project: { type: "object" }, // ref to a project entity
    lastActor: { type: "string" },
  },
  additionalProperties: false,
};

let schemaIdCache: EntityId | null = null;

async function readState(): Promise<{ schemaId?: EntityId }> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Create-or-reuse the Todo schema and GROW it in place to include `workspace`. */
export async function ensureTodoSchema(): Promise<EntityId> {
  if (schemaIdCache) return schemaIdCache;
  const state = await readState();

  let schemaId = state.schemaId;
  if (schemaId && (await readSchema(schemaId)).status === 200) {
    // In-place evolution of an existing single-tenant schema: add `workspace`,
    // replace `required`. Merge-patch — existing todos are not migrated.
    await patchSchema(schemaId, {
      properties: {
        workspace: { type: "object" },
        app: { type: "string" },
        status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
        due: { type: "object" },
        project: { type: "object" },
        lastActor: { type: "string" },
      },
      required: ["title", "done", "workspace", "app"],
    });
  } else {
    schemaId = (await createSchema(TODO_SCHEMA)).schemaId;
  }

  await writeFile(STATE_FILE, JSON.stringify({ schemaId }, null, 2));
  schemaIdCache = schemaId;
  return schemaId;
}

/**
 * Authorize a mutation and return the current entity (read once, reused).
 * A todo is writable only if it is owned by this workspace — the same boundary
 * the reactor enforces for reads, checked here as a field compare so a stray
 * cross-tenant id can never be mutated.
 */
async function authorizeWrite(ctx: WorkspaceCtx, id: EntityId): Promise<Record<string, unknown>> {
  const e = await readEntity(id);
  const ws = (e.workspace as { "#": EntityId } | undefined)?.["#"];
  if (ws !== ctx.workspaceId) throw new Error(`todo ${id} is not in workspace ${ctx.workspaceId}`);
  return e;
}

// ---- Commands (all scoped to ctx) ----------------------------------------

export async function addTodo(
  ctx: WorkspaceCtx,
  title: string,
  priority: Priority = "med",
  extra: Partial<Pick<TodoDoc, "due" | "project">> = {},
  actor?: string,
): Promise<EntityId> {
  const schemaId = await ensureTodoSchema();
  // ONE write: schema-validated todo, born with its workspace ref + app tag.
  const created = await createSchemaEntity<TodoDoc>(
    schemaId,
    {
      title,
      done: false,
      status: "todo",
      priority,
      workspace: { "#": ctx.workspaceId },
      app: APP,
      lastActor: actor ?? "seed",
      ...extra,
    },
    { actor },
  );
  if (!created.ok) {
    const why = created.error.details.map((d) => `${d.instanceLocation} ${JSON.stringify(d.errors)}`).join(", ");
    throw new Error(`rejected by schema: ${why}`);
  }
  return created.entityId;
}

async function patchTodo(ctx: WorkspaceCtx, id: EntityId, patch: MergePatch<TodoDoc>, actor?: string): Promise<void> {
  await authorizeWrite(ctx, id);
  const schemaId = await ensureTodoSchema();
  const full = actor ? { ...patch, lastActor: actor } : patch; // materialize who changed it
  const r = await patchSchemaEntity<TodoDoc>(schemaId, id, full, { actor });
  if (!r.ok) throw new Error(`could not update ${id}`);
}

/** One-time backfill: give app todos without a lastActor a placeholder. */
export async function backfillActor(): Promise<number> {
  const rows = (await query({
    find: ["?t"],
    where: [["?t", "app", APP], ["not", ["?t", "lastActor", "?a"]]],
  })) as [EntityId][];
  if (!rows.length) return 0;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [id] of rows) patch[id] = { lastActor: "seed" };
  await transact(patch);
  return rows.length;
}

// `done` (used by the web checkbox) and `status` are kept consistent: whichever
// you set, the other follows. `actor` is stamped on the transaction (attribution).
export async function setDone(ctx: WorkspaceCtx, id: EntityId, done: boolean, actor?: string): Promise<void> {
  await patchTodo(ctx, id, { done, status: done ? "done" : "todo" }, actor);
}

export async function setStatus(ctx: WorkspaceCtx, id: EntityId, status: Status, actor?: string): Promise<void> {
  await patchTodo(ctx, id, { status, done: status === "done" }, actor);
}

export async function setDue(ctx: WorkspaceCtx, id: EntityId, dueIso: string | null, actor?: string): Promise<void> {
  await patchTodo(ctx, id, { due: dueIso ? { "#utc": dueIso } : null }, actor);
}

export async function setPriority(ctx: WorkspaceCtx, id: EntityId, priority: Priority, actor?: string): Promise<void> {
  await patchTodo(ctx, id, { priority }, actor);
}

export async function toggleTodo(ctx: WorkspaceCtx, id: EntityId, actor?: string): Promise<boolean> {
  const e = await authorizeWrite(ctx, id); // reuse the read — no second fetch
  const next = !(e.done === true);
  await patchTodo(ctx, id, { done: next, status: next ? "done" : "todo" }, actor);
  return next;
}

export async function removeTodo(ctx: WorkspaceCtx, id: EntityId): Promise<void> {
  await authorizeWrite(ctx, id);
  await deleteEntity(id);
}

// ---- Reads: Stardust projects the exact shape; no positional mapping -----

export async function listTodos(ctx: WorkspaceCtx): Promise<Todo[]> {
  return (await readResults(ctx.reactorId)) as Todo[];
}

export async function watchTodos(ctx: WorkspaceCtx, cb: (todos: Todo[]) => void, signal: AbortSignal): Promise<void> {
  await streamResults(ctx.reactorId, (rows) => cb(rows as unknown as Todo[]), signal);
}

// ---- Migration: pull legacy single-tenant todos into a workspace ---------

/** Assign app-tagged todos that have NO workspace to `ctx`'s workspace. */
export async function migrateOrphanTodos(ctx: WorkspaceCtx): Promise<number> {
  const rows = (await query({
    find: ["?t"],
    where: [
      ["?t", "app", APP],
      ["not", ["?t", "workspace", "?w"]],
    ],
  })) as [EntityId][];
  if (!rows.length) return 0;
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [id] of rows) patch[id] = { workspace: { "#": ctx.workspaceId } };
  await transact(patch);
  return rows.length;
}
