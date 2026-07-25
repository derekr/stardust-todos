// Schemas for the entities that used to be written unchecked.
//
// Only `Todo` ever had a schema. Everything else — grants, sessions, the edges —
// went to /commands/transact, which accepts any fact: `role: "superuser"` on a
// grant committed with a 200. Since a schema is a boundary you opt into, adding
// one changes nothing until the write moves to /schemas/{id}/entities; both go
// together here.
//
// Not everything should get one. Tags and dependency edges are deliberately
// open-world — the app's whole point is that a `kind` is a convention, not a
// type, and adding a fact should not need a migration. What is schematised here
// is the state where a bad value is a SAFETY problem rather than a display bug:
// `role` decides authorization, and a malformed session drives the board reactor.

import { type EntityId } from "./stardust.ts";
import { ensureSchema } from "./registry.ts";

/** A ref to another entity: `{"#": 12}`. */
const ref = { type: "object" } as const;

const GRANT_SCHEMA = {
  title: "Grant",
  type: "object",
  properties: {
    kind: { const: "grant" },
    persona: ref,
    workspace: ref,
    // the reason this one is worth schematising: it is an authorization value
    role: { type: "string", enum: ["owner", "member"] },
  },
  required: ["kind", "persona", "workspace", "role"],
  additionalProperties: false,
};

const SESSION_SCHEMA = {
  title: "Session",
  type: "object",
  properties: {
    kind: { const: "session" },
    workspace: ref,
    viewer: ref,
    actor: { type: "string" },
    view: { type: "string", enum: ["all", "ready", "overdue", "mine", "done"] },
    tagActive: { type: "boolean" },
    rev: { type: "number" },
    sid: { type: "number" }, // set to the session's own id after creation
    group: { type: "string", enum: ["none", "status", "priority"] }, // display-only grouping
  },
  required: ["kind", "workspace", "viewer", "view", "tagActive", "rev"],
  additionalProperties: false,
};

const FACET_SCHEMA = {
  title: "SessionFacet",
  type: "object",
  properties: {
    kind: { const: "sf" },
    session: ref,
    facet: { type: "string", enum: ["status", "priority", "tag"] },
    value: { type: "string" },
  },
  required: ["kind", "session", "facet", "value"],
  additionalProperties: false,
};

const cache = new Map<string, Promise<EntityId>>();
/** The schema id for `name`, provisioned once per process. */
function idOf(name: string, doc: Record<string, unknown>): Promise<EntityId> {
  let p = cache.get(name);
  if (!p) {
    p = ensureSchema(name, doc);
    cache.set(name, p);
  }
  return p;
}

export const grantSchema = () => idOf("grant", GRANT_SCHEMA);
export const sessionSchema = () => idOf("session", SESSION_SCHEMA);
export const facetSchema = () => idOf("sf", FACET_SCHEMA);

/** Everything `npm run stardust:setup` provisions, besides the Todo schema. */
export const DECLARED_SCHEMAS = [
  { name: "grant", doc: GRANT_SCHEMA },
  { name: "session", doc: SESSION_SCHEMA },
  { name: "sf", doc: FACET_SCHEMA },
] as const;
