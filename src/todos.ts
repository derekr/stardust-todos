// Todo domain layer over Stardust — shared by the CLI and the web server.
//
// A "todo" is a schema-validated entity, tagged with an open-world `app` fact
// so one reactor can watch exactly this app's todos. The reactor's live SSE
// results are what both frontends render — so every client stays in sync.

import { readFile, writeFile } from "node:fs/promises";
import {
  type EntityId,
  createReactor,
  createSchema,
  createSchemaEntity,
  deleteEntity,
  patchSchemaEntity,
  readEntity,
  readResults,
  readSchema,
  streamResults,
  transact,
} from "./stardust.ts";

export type Priority = "low" | "med" | "high";

export interface Todo {
  id: EntityId;
  title: string;
  done: boolean;
  priority: Priority;
}

/** Fields the schema validates. `app` is written open-world, beside the schema. */
interface TodoDoc {
  title: string;
  done: boolean;
  priority: Priority;
}

const APP = "todo-app";
const STATE_FILE = new URL("../.state.json", import.meta.url);

const TODO_SCHEMA = {
  title: "Todo",
  type: "object",
  required: ["title", "done"],
  properties: {
    title: { type: "string", minLength: 1 },
    done: { type: "boolean" },
    priority: { type: "string", enum: ["low", "med", "high"] },
  },
  additionalProperties: false,
};

interface State {
  schemaId: EntityId;
  reactorId: EntityId;
}
let state: State | null = null;

async function loadState(): Promise<State | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch {
    return null;
  }
}

/** Ensure the schema + list reactor exist; cache their ids to `.state.json`. */
export async function setup(): Promise<State> {
  if (state) return state;

  const cached = await loadState();
  if (cached && (await readSchema(cached.schemaId)).status === 200) {
    try {
      await readResults(cached.reactorId); // reactor still there?
      state = cached;
      return state;
    } catch {
      /* fall through and rebuild the reactor */
    }
  }

  const schemaId = cached?.schemaId ?? (await createSchema(TODO_SCHEMA)).schemaId;
  const reactorId = await createReactor({
    enabled: true,
    find: ["?t", "?title", "?done", "?priority"],
    where: [
      ["?t", "app", APP],
      ["?t", "title", "?title"],
      ["?t", "done", "?done"],
      ["?t", "priority", "?priority"],
    ],
    orderBy: ["?done", "?priority", "?title"],
  });

  state = { schemaId, reactorId };
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

function toTodos(rows: unknown[]): Todo[] {
  return (rows as [EntityId, string, boolean, Priority][]).map(([id, title, done, priority]) => ({
    id,
    title,
    done,
    priority,
  }));
}

// ---- Commands -------------------------------------------------------------

export async function addTodo(title: string, priority: Priority = "med"): Promise<EntityId> {
  const { schemaId } = await setup();
  const created = await createSchemaEntity<TodoDoc>(schemaId, { title, done: false, priority });
  if (!created.ok) {
    const why = created.error.details.map((d) => `${d.instanceLocation} ${JSON.stringify(d.errors)}`).join(", ");
    throw new Error(`rejected by schema: ${why}`);
  }
  await transact({ [created.entityId]: { app: APP } }); // open-world tag
  return created.entityId;
}

export async function setDone(id: EntityId, done: boolean): Promise<void> {
  const { schemaId } = await setup();
  const r = await patchSchemaEntity<TodoDoc>(schemaId, id, { done });
  if (!r.ok) throw new Error(`could not update ${id}`);
}

export async function toggleTodo(id: EntityId): Promise<boolean> {
  const cur = await readEntity(id);
  const next = !(cur.done === true);
  await setDone(id, next);
  return next;
}

export async function removeTodo(id: EntityId): Promise<void> {
  await deleteEntity(id); // retracts every current field, incl. the app tag
}

// ---- Reads ----------------------------------------------------------------

export async function listTodos(): Promise<Todo[]> {
  const { reactorId } = await setup();
  return toTodos(await readResults(reactorId));
}

/** Subscribe to live todo lists. Fires cb on every change until aborted. */
export async function watchTodos(cb: (todos: Todo[]) => void, signal: AbortSignal): Promise<void> {
  const { reactorId } = await setup();
  await streamResults(reactorId, (rows) => cb(toTodos(rows)), signal);
}
