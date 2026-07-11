// The observable-field vocabulary for typed queries.
//
// Stardust has no entity types — a field names what a component means for an
// entity. So the query layer is typed by FIELDS, in two halves:
//   - schema-derived (generated): fields covered by a schema boundary. These
//     carry a real guarantee — Stardust validates writes against the schema.
//   - declared (below): fields we write OPEN-WORLD with no schema (edge/infra
//     facts like kind/role/label/blocker). No engine guarantee — this is the
//     app asserting its own conventions. Add a schema for any of them and they
//     move to the generated half automatically, gaining the real guarantee.

import type { Ref, SchemaFieldTypes } from "./generated/schema-fields.ts";
import { schemaValidators } from "./generated/schema-fields.ts";

export type { Ref, Instant } from "./generated/schema-fields.ts";

/** Open-world fields — declared by convention, not enforced by a schema. */
export interface DeclaredFields {
  kind: "user" | "persona" | "workspace" | "grant" | "command" | "tag" | "dep";
  name: string; // workspace / persona name
  role: "owner" | "member";
  label: string; // tag label
  todo: Ref; // edge → todo
  blocker: Ref; // dep edge → blocker
  persona: Ref; // grant → persona
  reactor: Ref; // workspace → its reactor
  adopts: boolean;
  cmdId: string;
  minRank: number;
  showWhenDenied: boolean;
  danger: boolean;
  scope: "global" | "todo";
  order: number;
}

/** Full vocabulary = schema-derived ∪ declared. (No key overlap by design;
 *  a field meaning that genuinely varies by kind — e.g. project vs todo status
 *  — would need a union here, the one place Stardust's field-not-a-class model
 *  can bite.) */
export interface FieldTypes extends SchemaFieldTypes, DeclaredFields {}

const isRef = (v: unknown) => typeof (v as { "#"?: unknown })?.["#"] === "number";
export const validators: Record<string, (v: unknown) => boolean> = {
  ...schemaValidators,
  kind: (v) => typeof v === "string",
  name: (v) => typeof v === "string",
  role: (v) => v === "owner" || v === "member",
  label: (v) => typeof v === "string",
  todo: isRef,
  blocker: isRef,
  persona: isRef,
  reactor: isRef,
  adopts: (v) => typeof v === "boolean",
  cmdId: (v) => typeof v === "string",
  minRank: (v) => typeof v === "number",
  showWhenDenied: (v) => typeof v === "boolean",
  danger: (v) => typeof v === "boolean",
  scope: (v) => v === "global" || v === "todo",
  order: (v) => typeof v === "number",
};
