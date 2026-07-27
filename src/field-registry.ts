// The observable-field vocabulary for typed queries.
//
// Stardust has no entity types — a field names what a component means for an
// entity. So the query layer is typed by FIELDS, in two halves:
//   - schema-derived (generated): fields covered by a schema boundary. These
//     carry a real guarantee — Stardust validates writes against the schema.
//   - declared (below): fields we write OPEN-WORLD with no schema (edge/infra
//     facts like kind/label/blocker). No engine guarantee — this is the app
//     asserting its own conventions. Add a schema for any of them and they move
//     to the generated half automatically, gaining the real guarantee — which is
//     what just happened to role, persona, author and draft.

import type { Ref, SchemaFieldTypes } from "./generated/schema-fields.ts";
import { schemaValidators } from "./generated/schema-fields.ts";

/** Open-world fields — declared by convention, not enforced by a schema. */
interface DeclaredFields {
  // spans schematised and open-world entities alike — see FieldTypes below
  kind:
    | "user"
    | "persona"
    | "workspace"
    | "grant"
    | "command"
    | "tag"
    | "dep"
    | "project"
    | "pgset"
    | "pg"
    | "reactorRef"
    | "schemaRef";
  name: string; // workspace / persona / project name
  email: string; // user login identity
  user: Ref; // persona → user
  label: string; // tag label
  todo: Ref; // edge → todo
  pgset: Ref; // page row → the page-set it belongs to
  blocker: Ref; // dep edge → blocker
  reactor: Ref; // workspace → its board reactor
  countsReactor: Ref; // workspace → its aggregate (counts) reactor
  adopts: boolean;
  cmdId: string;
  minRank: number;
  showWhenDenied: boolean;
  danger: boolean;
  scope: "global" | "todo";
  order: number;
}

/**
 * Full vocabulary = schema-derived ∪ declared.
 *
 * `kind` is the one field that genuinely spans both halves, and it is the place
 * Stardust's field-is-not-a-class model bites. Each schema pins it to a `const`
 * discriminator, so the generator — seeing three different consts for one field —
 * can only widen it to `unknown`; and even a union of those three would be wrong,
 * because tags, deps, users and the rest carry a `kind` with no schema at all.
 * The declared union below is the honest global type, so it wins here. Its
 * validator likewise overrides the generated `() => true`.
 */
export interface FieldTypes extends Omit<SchemaFieldTypes, "kind">, DeclaredFields {}

const isRef = (v: unknown) => typeof (v as { "#"?: unknown })?.["#"] === "number";
export const validators: Record<string, (v: unknown) => boolean> = {
  ...schemaValidators,
  kind: (v) => typeof v === "string",
  name: (v) => typeof v === "string",
  email: (v) => typeof v === "string",
  user: isRef,
  label: (v) => typeof v === "string",
  todo: isRef,
  pgset: isRef,
  blocker: isRef,
  reactor: isRef,
  countsReactor: isRef,
  adopts: (v) => typeof v === "boolean",
  cmdId: (v) => typeof v === "string",
  minRank: (v) => typeof v === "number",
  showWhenDenied: (v) => typeof v === "boolean",
  danger: (v) => typeof v === "boolean",
  scope: (v) => v === "global" || v === "todo",
  order: (v) => typeof v === "number",
};
