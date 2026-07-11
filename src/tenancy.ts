// Tenancy model: user -> persona -> workspace, plus persona<->workspace grants.
//
//   user       a login identity (email). Has one or more personas.
//   persona    a "hat" a user wears (Work / Personal). The principal that
//              owns and joins workspaces.
//   workspace  the DATA-ISOLATION boundary. Todos live inside one workspace.
//   grant      an edge fact: (persona, workspace, role). Access = a grant exists.
//
// Everything here is plain Stardust facts written with generic transact and
// distinguished by a `kind` field. No schema is required for infra entities;
// the isolation guarantees come from how queries are shaped, not from classes.

import { type EntityId, createReactor, query, readEntity, transact } from "./stardust.ts";

export type Role = "owner" | "member";
export const APP = "todo-app";

export interface Persona {
  id: EntityId;
  name: string;
  user: EntityId;
}
export interface Workspace {
  id: EntityId;
  name: string;
  reactorId: EntityId;
}

export class AccessDenied extends Error {
  constructor(personaId: EntityId, workspaceId: EntityId) {
    super(`persona ${personaId} has no grant on workspace ${workspaceId}`);
    this.name = "AccessDenied";
  }
}

// A find column bound in a ref position comes back as {"#": id}; in a subject
// position it comes back as a bare number. Normalize either to a number.
const asId = (v: unknown): EntityId => (typeof v === "number" ? v : (v as { "#": EntityId })["#"]);
const tempId = async (patch: Record<string, unknown>): Promise<EntityId> => {
  const r = await transact({ "#_x": patch });
  return r.tempIds!.x;
};

// ---- Users ---------------------------------------------------------------

export async function findUser(email: string): Promise<EntityId | null> {
  const rows = (await query({
    find: ["?u"],
    where: [
      ["?u", "kind", "user"],
      ["?u", "email", email],
    ],
    limit: 1,
  })) as [EntityId][];
  return rows.length ? rows[0][0] : null;
}

export async function ensureUser(email: string): Promise<EntityId> {
  return (await findUser(email)) ?? (await tempId({ kind: "user", email }));
}

// ---- Personas ------------------------------------------------------------

export async function createPersona(userId: EntityId, name: string): Promise<EntityId> {
  return tempId({ kind: "persona", name, user: { "#": userId } });
}

export async function listPersonas(userId: EntityId): Promise<Persona[]> {
  const rows = (await query({
    find: ["?p", "?name"],
    where: [
      ["?p", "kind", "persona"],
      ["?p", "user", { "#": userId }],
      ["?p", "name", "?name"],
    ],
    orderBy: ["?name"],
  })) as [EntityId, string][];
  return rows.map(([id, name]) => ({ id, name, user: userId }));
}

// ---- Workspaces + grants -------------------------------------------------

/**
 * Create a workspace owned by `personaId`. This mints a PER-WORKSPACE reactor
 * whose `where` PINS a single clause — `workspace = {# id}` — and whose
 * `then.project` returns app-shaped {id,title,done,priority} objects. Stardust
 * does the filtering, ordering AND shaping.
 *
 * The single pinned clause is the isolation boundary and is verified airtight.
 * (A cleverer `or(owned, "has no workspace")` scope was tried to avoid
 * migrating legacy data, but testing showed `or` + `not` OVER-matches and
 * leaks another workspace's todos — so the boundary stays a single clause.)
 * Callers only ever hold the reactor id, never the filter, so they cannot
 * widen it.
 */
export async function createWorkspace(personaId: EntityId, name: string): Promise<Workspace> {
  const id = await tempId({ kind: "workspace", name });

  const reactorId = await createReactor({
    enabled: true,
    find: ["?t", "?title", "?done", "?priority", "?status"],
    where: [
      ["?t", "app", APP],
      ["?t", "workspace", { "#": id }], // <-- tenant boundary, single pinned clause
      ["?t", "title", "?title"],
      ["?t", "done", "?done"],
      ["?t", "priority", "?priority"],
      ["?t", "status", "?status"],
    ],
    orderBy: ["?done", "?priority", "?title"],
    then: { project: { id: "?t", title: "?title", done: "?done", priority: "?priority", status: "?status" } },
  });

  await transact({ [id]: { reactor: { "#": reactorId } } });
  await grantAccess(id, personaId, "owner");
  return { id, name, reactorId };
}

export async function grantAccess(workspaceId: EntityId, personaId: EntityId, role: Role): Promise<void> {
  await tempId({
    kind: "grant",
    persona: { "#": personaId },
    workspace: { "#": workspaceId },
    role,
  });
}

/** Workspaces this persona may access, resolved through grants. */
export async function listWorkspaces(personaId: EntityId): Promise<Workspace[]> {
  const rows = (await query({
    find: ["?ws", "?name", "?reactor"],
    where: [
      ["?g", "kind", "grant"],
      ["?g", "persona", { "#": personaId }],
      ["?g", "workspace", "?ws"],
      ["?ws", "name", "?name"],
      ["?ws", "reactor", "?reactor"],
    ],
    orderBy: ["?name"],
  })) as [{ "#": EntityId }, string, { "#": EntityId }][];
  return rows.map(([id, name, reactor]) => ({ id: asId(id), name, reactorId: asId(reactor) }));
}

/** Throws AccessDenied unless a grant links persona -> workspace. */
export async function assertAccess(personaId: EntityId, workspaceId: EntityId): Promise<void> {
  const rows = await query({
    find: ["?g"],
    where: [
      ["?g", "kind", "grant"],
      ["?g", "persona", { "#": personaId }],
      ["?g", "workspace", { "#": workspaceId }],
    ],
    limit: 1,
  });
  if (!rows.length) throw new AccessDenied(personaId, workspaceId);
}

export async function workspaceReactor(workspaceId: EntityId): Promise<EntityId> {
  const ws = await readEntity(workspaceId);
  return asId(ws.reactor);
}

/** The persona's role on a workspace, read from the grant fact. */
export async function roleOf(personaId: EntityId, workspaceId: EntityId): Promise<Role | null> {
  const rows = (await query({
    find: ["?role"],
    where: [
      ["?g", "kind", "grant"],
      ["?g", "persona", { "#": personaId }],
      ["?g", "workspace", { "#": workspaceId }],
      ["?g", "role", "?role"],
    ],
    limit: 1,
  })) as [Role][];
  return rows.length ? rows[0][0] : null;
}
