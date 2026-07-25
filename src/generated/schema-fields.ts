// GENERATED from Stardust schemas — do not edit by hand.  npm run gen:query
// A FIELD registry (Stardust has no entity types — schemas are boundaries).

export type Ref = { "#": number };
export type Instant = { "#utc": string };

export interface SchemaFieldTypes {
  actor: string;  // from Session
  app: string;  // from Todo
  author: Ref;  // from Todo
  done: boolean;  // from Todo
  draft: boolean;  // from Todo
  due: Instant;  // from Todo
  facet: "status" | "priority" | "tag";  // from SessionFacet
  kind: unknown;  // from Grant, Session, SessionFacet
  lastActor: string;  // from Todo
  persona: Ref;  // from Grant
  priority: "low" | "med" | "high";  // from Todo
  project: Ref;  // from Todo
  rev: number;  // from Session
  role: "owner" | "member";  // from Grant
  session: Ref;  // from SessionFacet
  sid: number;  // from Session
  status: "todo" | "doing" | "blocked" | "done";  // from Todo
  tagActive: boolean;  // from Session
  title: string;  // from Todo
  value: string;  // from SessionFacet
  view: "all" | "ready" | "overdue" | "mine" | "done";  // from Session
  viewer: Ref;  // from Session
  workspace: Ref;  // from Todo, Grant, Session
}

export const schemaValidators = {
  actor: (v) => typeof v === "string",
  app: (v) => typeof v === "string",
  author: (v) => typeof (v as any)?.["#"] === "number",
  done: (v) => typeof v === "boolean",
  draft: (v) => typeof v === "boolean",
  due: (v) => typeof (v as any)?.["#utc"] === "string",
  facet: (v) => (["status","priority","tag"] as unknown[]).includes(v),
  kind: () => true,
  lastActor: (v) => typeof v === "string",
  persona: (v) => typeof (v as any)?.["#"] === "number",
  priority: (v) => (["low","med","high"] as unknown[]).includes(v),
  project: (v) => typeof (v as any)?.["#"] === "number",
  rev: (v) => typeof v === "number",
  role: (v) => (["owner","member"] as unknown[]).includes(v),
  session: (v) => typeof (v as any)?.["#"] === "number",
  sid: (v) => typeof v === "number",
  status: (v) => (["todo","doing","blocked","done"] as unknown[]).includes(v),
  tagActive: (v) => typeof v === "boolean",
  title: (v) => typeof v === "string" && v.length >= 1,
  value: (v) => typeof v === "string",
  view: (v) => (["all","ready","overdue","mine","done"] as unknown[]).includes(v),
  viewer: (v) => typeof (v as any)?.["#"] === "number",
  workspace: (v) => typeof (v as any)?.["#"] === "number",
} satisfies Record<keyof SchemaFieldTypes, (v: unknown) => boolean>;
