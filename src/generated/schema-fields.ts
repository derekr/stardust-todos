// GENERATED from Stardust schemas — do not edit by hand.  npm run gen:query
// A FIELD registry (Stardust has no entity types — schemas are boundaries).

export type Ref = { "#": number };
export type Instant = { "#utc": string };

export interface SchemaFieldTypes {
  app: string;  // from Todo
  author: Ref;  // from Todo
  done: boolean;  // from Todo
  draft: boolean;  // from Todo
  due: Instant;  // from Todo
  lastActor: string;  // from Todo
  priority: "low" | "med" | "high";  // from Todo
  project: Ref;  // from Todo
  status: "todo" | "doing" | "blocked" | "done";  // from Todo
  title: string;  // from Todo
  workspace: Ref;  // from Todo
}

export const schemaValidators = {
  app: (v) => typeof v === "string",
  author: (v) => typeof (v as any)?.["#"] === "number",
  done: (v) => typeof v === "boolean",
  draft: (v) => typeof v === "boolean",
  due: (v) => typeof (v as any)?.["#utc"] === "string",
  lastActor: (v) => typeof v === "string",
  priority: (v) => (["low","med","high"] as unknown[]).includes(v),
  project: (v) => typeof (v as any)?.["#"] === "number",
  status: (v) => (["todo","doing","blocked","done"] as unknown[]).includes(v),
  title: (v) => typeof v === "string" && v.length >= 1,
  workspace: (v) => typeof (v as any)?.["#"] === "number",
} satisfies Record<keyof SchemaFieldTypes, (v: unknown) => boolean>;
