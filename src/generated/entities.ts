// GENERATED from Stardust schemas — do not edit by hand.
// Regenerate:  npm run gen:types   (with Stardust running)

export type Ref = { "#": number };
export type Instant = { "#utc": string };

export interface Todo {
  app: string;
  done: boolean;
  due?: Instant;
  lastActor?: string;
  priority?: "low" | "med" | "high";
  project?: Ref;
  status?: "todo" | "doing" | "blocked" | "done";
  title: string;
  workspace: Ref;
}

