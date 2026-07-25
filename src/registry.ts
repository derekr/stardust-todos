// Names for the things this app provisions in Stardust.
//
// A reactor and a schema are both stored state, and both are addressed by an
// entity id the app has to remember. Remembering it OUTSIDE the database is the
// bug: the board reactor kept its id in a module variable and minted a new
// reactor per restart, and the Todo schema kept its id in .state.json and minted
// a new schema whenever that file was missing — the live demo accumulated five
// identical Todo schemas that way.
//
// So the id lives in the database, next to the thing it names: a tiny marker
// entity mapping (app, kind, name) -> target. Provisioning becomes "look up the
// marker; create only if it is absent", which is safe to run on every boot.
//
// The trade against creating at a fixed id (`POST /reactors/{id}`, atomic 409):
// two processes racing here can both miss the marker and both create. That is a
// deploy-time step, not a hot path, so the simpler model wins — and fixed ids
// turned out not to generalize anyway (see reactors.ts).

import { type EntityId, createSchema, patchSchema, query, readSchema, refId, transact } from "./stardust.ts";
import { APP } from "./tenancy.ts";

/** What a marker points at. One kind per sort of provisioned thing. */
export type RefKind = "reactorRef" | "schemaRef";

/** The entity previously provisioned under this (kind, name), if any. */
export async function lookupRef(kind: RefKind, name: string): Promise<EntityId | undefined> {
  const rows = (await query({
    find: ["?r", "?target"],
    where: [
      ["?r", "kind", kind],
      ["?r", "app", APP],
      ["?r", "name", name],
      ["?r", "target", "?target"],
    ],
  })) as [unknown, unknown][];
  return rows.length ? refId(rows[0][1]) : undefined;
}

/** Record that `target` is the thing called `name`. */
export async function putRef(kind: RefKind, name: string, target: EntityId): Promise<void> {
  await transact({ "#_ref": { kind, app: APP, name, target: { "#": target } } });
}

/**
 * Make the schema named `name` exist and match `doc`, and return its id.
 *
 * Schemas are WRITE BOUNDARIES you opt into: entities written through
 * `/schemas/{id}/entities` are validated and a bad value is refused with 422,
 * while the same fact sent to `/commands/transact` commits unchecked. So giving a
 * kind a schema only means something once its writes move to the schema route.
 *
 * Growth is a merge-patch of the whole document — adding a property or widening
 * `required` is not a migration, and existing entities are untouched.
 */
export async function ensureSchema(name: string, doc: Record<string, unknown>): Promise<EntityId> {
  const existing = await lookupRef("schemaRef", name);
  if (existing !== undefined && (await readSchema(existing)).status === 200) {
    await patchSchema(existing, doc);
    return existing;
  }
  const id = (await createSchema(doc)).schemaId;
  await putRef("schemaRef", name, id);
  return id;
}
