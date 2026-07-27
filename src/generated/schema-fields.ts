// GENERATED from Stardust schemas — do not edit by hand.  npm run gen:query
// A FIELD registry (Stardust has no entity types — schemas are boundaries).

export type Ref = { "#": number };
export type Instant = { "#utc": string };

export interface SchemaFieldTypes {
  app: string;  // from Todo
  author: Ref;  // from Todo
  blocked: boolean;  // from Todo
  done: boolean;  // from Todo
  draft: boolean;  // from Todo
  due: Instant;  // from Todo
  effectiveStatus: "todo" | "doing" | "blocked" | "done";  // from Todo
  kind: unknown;  // from Grant
  lastActor: string;  // from Todo
  persona: Ref;  // from Grant
  prank: number;  // from Todo
  priority: "low" | "med" | "high";  // from Todo
  project: Ref;  // from Todo
  role: "owner" | "member";  // from Grant
  status: "todo" | "doing" | "blocked" | "done";  // from Todo
  title: string;  // from Todo
  workspace: Ref;  // from Todo, Grant
}

export const schemaValidators = {
  app: (v) => typeof v === "string",
  author: (v) => typeof (v as any)?.["#"] === "number",
  blocked: (v) => typeof v === "boolean",
  done: (v) => typeof v === "boolean",
  draft: (v) => typeof v === "boolean",
  due: (v) => typeof (v as any)?.["#utc"] === "string",
  effectiveStatus: (v) => (["todo","doing","blocked","done"] as unknown[]).includes(v),
  kind: () => true,
  lastActor: (v) => typeof v === "string",
  persona: (v) => typeof (v as any)?.["#"] === "number",
  prank: (v) => typeof v === "number",
  priority: (v) => (["low","med","high"] as unknown[]).includes(v),
  project: (v) => typeof (v as any)?.["#"] === "number",
  role: (v) => (["owner","member"] as unknown[]).includes(v),
  status: (v) => (["todo","doing","blocked","done"] as unknown[]).includes(v),
  title: (v) => typeof v === "string" && v.length >= 1,
  workspace: (v) => typeof (v as any)?.["#"] === "number",
} satisfies Record<keyof SchemaFieldTypes, (v: unknown) => boolean>;
