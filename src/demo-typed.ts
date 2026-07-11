// Typing `query` — three levels, and where a runtime validator earns its keep.
//
//   node src/demo-typed.ts
//
// Level 1  compile-time only  — query<T>() casts the result. Zero runtime cost,
//          zero runtime guarantee: if Stardust returns a different shape (schema
//          drift, a projection bug), TypeScript never knows.
// Level 2  generated types    — import Todo from src/generated (json-schema-to-
//          typescript over the LIVE schema). Autocomplete + the enum unions,
//          regenerated when the schema evolves.
// Level 3  runtime-validated  — parse each row with arktype at the network
//          boundary. The type is INFERRED from the validator, so the runtime
//          check and the compile-time type cannot drift.

import { ArkErrors, type } from "arktype";
import { query } from "./stardust.ts";
import type { Todo } from "./generated/entities.ts";
import { defaultWorkspace } from "./workspace.ts";
import { APP } from "./tenancy.ts";

const c = { g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, d: (s: string) => `\x1b[2m${s}\x1b[0m` };

// The projection our board reactor returns. Written once, in arktype's TS-like
// syntax; `TodoRow` (the type) is inferred from it — single source of truth.
const TodoRow = type({
  id: "number",
  title: "string",
  status: "'todo' | 'doing' | 'blocked' | 'done'",
  done: "boolean",
  priority: "'low' | 'med' | 'high'",
  "lastActor?": "string",
});
type TodoRow = typeof TodoRow.infer;

/** query + validate-at-the-boundary. Throws if the shape doesn't match. */
async function queryChecked<T>(validator: { array(): (v: unknown) => T[] | ArkErrors }, body: unknown): Promise<T[]> {
  const raw = await query(body);
  const out = validator.array()(raw);
  if (out instanceof ArkErrors) throw new Error(`query result failed validation:\n${out.summary}`);
  return out;
}

async function main() {
  const ctx = await defaultWorkspace();
  const projection = {
    find: ["?t", "?title", "?done", "?priority", "?status", "?lastActor"],
    where: [
      ["?t", "app", APP],
      ["?t", "workspace", { "#": ctx.workspaceId }],
      ["?t", "title", "?title"],
      ["?t", "done", "?done"],
      ["?t", "priority", "?priority"],
      ["?t", "status", "?status"],
      ["?t", "lastActor", "?lastActor"],
    ],
    orderBy: ["?title"],
    limit: 3,
    then: {
      project: { id: "?t", title: "?title", done: "?done", priority: "?priority", status: "?status", lastActor: "?lastActor" },
    },
  };

  console.log(c.d("\nLevel 1 — query<T>(): compile-time cast, no runtime check"));
  const l1 = await query<TodoRow>(projection); // typed, but a lie if the shape drifts
  console.log("  got", l1.length, "rows; first title:", l1[0]?.title);

  console.log(c.d("\nLevel 2 — generated Todo type (from the live schema)"));
  const t: Todo["status"] = "blocked"; // autocompletes to the 4 statuses; enum came from Stardust
  console.log("  Todo.status is a union incl.", t, "— regenerate with `npm run gen:types`");

  console.log(c.d("\nLevel 3 — runtime-validated with arktype (type inferred from the validator)"));
  const rows = await queryChecked(TodoRow, projection);
  console.log(c.g(`  ✓ ${rows.length} rows validated at the boundary`));
  for (const r of rows) console.log(`    ${String(r.id).padEnd(4)} ${r.status.padEnd(8)} ${r.title}`);

  console.log(c.d("\n  Now feed it a WRONG shape (status not in the enum) — the boundary catches it:"));
  const bad = TodoRow.array()([{ id: 1, title: "x", status: "archived", done: false, priority: "med" }]);
  console.log(bad instanceof ArkErrors ? c.r(`  ✗ rejected: ${bad.summary}`) : c.r("  (should have failed)"));

  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
