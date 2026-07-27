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

// A `Session` and a `SessionFacet` schema used to sit here, because the board's
// filter was facts on a session entity and a malformed one drove the board query.
// The filter is a query string now (filter.ts), so there is no session to
// schematise — and the check those schemas were really providing has not gone
// anywhere, it has moved to where the value now enters: `decodeFilter` refuses a
// status, priority, view, group or tag that is not in its domain, and
// `canonicalBody` refuses it again. A schema validating a write the app was about
// to read back was one hop further from the hazard than that.
//
// What went with them, and is worth noticing: the generated `facet` and `value`
// validators. They existed because `writeFacets` bypassed the schema route (a
// transact writes facts unchecked, and there is no batch form of
// `POST /schemas/{id}/entities`), so the app checked its own writes against the
// validators its own schema generated. That circle is gone with the writes.

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

/** Everything `npm run stardust:setup` provisions, besides the Todo schema. */
export const DECLARED_SCHEMAS = [{ name: "grant", doc: GRANT_SCHEMA }] as const;
