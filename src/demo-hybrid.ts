// The hybrid typed query, end to end.
//   node src/demo-hybrid.ts
//
// Everything below writes the SAME plain JSON you'd write today. The generated
// field map makes invalid queries a COMPILE error; the generated validators
// check the result at the boundary; and valid projections come back typed.

import { query } from "./typed-query.ts";
import { defaultWorkspace } from "./workspace.ts";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const d = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main() {
  const ctx = await defaultWorkspace();
  const WS = ctx.workspaceId;

  console.log(d("\n1 — projection: result is typed (status narrows to the schema enum)"));
  const todos = await query({
    find: ["?t", "?title", "?status"],
    where: [
      ["?t", "app", "todo-app"],
      ["?t", "workspace", { "#": WS }],
      ["?t", "title", "?title"],
      ["?t", "status", "?status"],
    ],
    then: { project: { id: "?t", title: "?title", status: "?status" } },
  } as const);
  for (const t of todos) {
    const badge: Record<typeof t.status, string> = { todo: "·", doing: "»", blocked: "⛔", done: "✓" };
    console.log(`   ${badge[t.status]} #${t.id} ${t.title}`); // t.status is "todo"|"doing"|"blocked"|"done"
  }

  console.log(d("\n2 — predicate + contains {#set}, both type-checked against the field types"));
  const active = await query({
    find: ["?t", "?title", "?priority"],
    where: [
      ["?t", "app", "todo-app"],
      ["?t", "workspace", { "#": WS }],
      ["?t", "title", "?title"],
      ["?t", "priority", "?priority"],
      ["?t", "status", "?status"],
      ["contains", { "#set": ["todo", "doing"] }, "?status"],
    ],
    orderBy: ["?title"],
    then: { project: { title: "?title", priority: "?priority" } },
  } as const);
  for (const t of active) console.log(`   ${t.priority.padEnd(4)} ${t.title}`); // t.priority: "low"|"med"|"high"

  console.log(d("\n3 — a MULTI-KIND query, typed purely by FIELDS (no 'entity type' anywhere)"));
  const grants = await query({
    find: ["?wsName", "?role"],
    where: [
      ["?g", "kind", "grant"],
      ["?g", "persona", { "#": ctx.personaId }],
      ["?g", "workspace", "?w"],
      ["?w", "name", "?wsName"],
      ["?g", "role", "?role"],
    ],
    then: { project: { workspace: "?wsName", role: "?role" } },
  } as const);
  for (const g2 of grants) console.log(`   ${g2.role.padEnd(6)} on ${g2.workspace}`); // role: "owner"|"member"

  console.log(g(`\n   ✓ ${todos.length} + ${active.length} + ${grants.length} rows validated at the boundary`));
  console.log(d("   (invalid-query compile proofs live in _wontCompile below — see the source)\n"));
}

// Never called — these are COMPILE-TIME proofs. Each @ts-expect-error MUST error,
// or tsgo fails; the valid variant beside it compiles. Invalid queries can't be
// written. (They don't run — the function is unreachable.)
async function _wontCompile() {
  // @ts-expect-error — "archived" is not a valid status enum value
  await query({ find: ["?t"], where: [["?t", "status", "archived"]] } as const);
  // valid:
  await query({ find: ["?t"], where: [["?t", "status", "done"]] } as const);

  // @ts-expect-error — done is boolean, not the string "yes"
  await query({ find: ["?t"], where: [["?t", "done", "yes"]] } as const);

  // @ts-expect-error — priority "urgent" isn't in the enum
  await query({ find: ["?t"], where: [["?t", "priority", "urgent"]] } as const);

  // @ts-expect-error — can't use `<` on a boolean field
  await query({ find: ["?t"], where: [["?t", "done", "?d"], ["<", "?d", true]] } as const);

  // @ts-expect-error — `contains {#set}` needs a scalar field, not boolean
  await query({ find: ["?t"], where: [["?t", "done", "?d"], ["contains", { "#set": [true] }, "?d"]] } as const);

  // @ts-expect-error — #set elements must match the field type (status, not numbers)
  await query({ find: ["?t"], where: [["?t", "status", "?s"], ["contains", { "#set": [1, 2] }, "?s"]] } as const);

  // @ts-expect-error — unknown field 'colour'
  await query({ find: ["?t"], where: [["?t", "colour", "red"]] } as const);

  // @ts-expect-error — aggregate op is only legal in `find`, not `where`
  await query({ find: ["?t"], where: [["count", "?t", "?x"]] } as const);

  // Declared (open-world) fields are typed too:
  // @ts-expect-error — role only allows "owner" | "member"
  await query({ find: ["?g"], where: [["?g", "role", "admin"]] } as const);
  // valid:
  await query({
    find: ["?g"],
    where: [
      ["?g", "kind", "grant"],
      ["?g", "role", "owner"],
    ],
  } as const);
}
void _wontCompile;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
