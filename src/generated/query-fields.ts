// GENERATED from Stardust schemas — do not edit by hand.
// Regenerate:  npm run gen:query   (with Stardust running)

export type Ref = { "#": number };
export type Instant = { "#utc": string };

export interface TodoFields {
  app: string;
  done: boolean;
  due: Instant;
  lastActor: string;
  priority: "low" | "med" | "high";
  project: Ref;
  status: "todo" | "doing" | "blocked" | "done";
  title: string;
  workspace: Ref;
}

export const todoValidators = {
  app: (v) => typeof v === "string",
  done: (v) => typeof v === "boolean",
  due: (v) => typeof (v as any)?.["#utc"] === "string",
  lastActor: (v) => typeof v === "string",
  priority: (v) => (["low","med","high"] as unknown[]).includes(v),
  project: (v) => typeof (v as any)?.["#"] === "number",
  status: (v) => (["todo","doing","blocked","done"] as unknown[]).includes(v),
  title: (v) => typeof v === "string" && v.length >= 1,
  workspace: (v) => typeof (v as any)?.["#"] === "number",
} satisfies Record<keyof TodoFields, (v: unknown) => boolean>;

