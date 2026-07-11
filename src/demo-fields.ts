// Stage 1 evolution proof: rich exploration fields added AFTER launch.
// status, due dates, tags (edges), dependencies (edges) — none designed up front.
//
//   node src/demo-fields.ts     (STARDUST_URL defaults to http://localhost:1981)

import { addTag, blocked, overdue, ready, removeTag, todosByTag, tagsOf, addDependency } from "./features.ts";
import { addTodo, listTodos, setStatus } from "./todos.ts";
import { createPersona, createWorkspace, ensureUser } from "./tenancy.ts";
import { openWorkspace } from "./workspace.ts";

const tag = `f${Date.now().toString().slice(-6)}`;
let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${m}`);
  c ? pass++ : fail++;
};
const h = (s: string) => console.log(`\n\x1b[1m\x1b[36m${s}\x1b[0m`);
const iso = (daysFromNow: number) => new Date(Date.parse("2026-07-11T00:00:00Z") + daysFromNow * 864e5).toISOString();

async function main() {
  // fresh isolated workspace for this run
  const user = await ensureUser(`fields.${tag}@example.test`);
  const persona = await createPersona(user, `P ${tag}`);
  const ws = await createWorkspace(persona, `Fields ${tag}`);
  const ctx = await openWorkspace(persona, ws.id);

  h("Add todos with due dates (Stardust instants)");
  const spec = await addTodo(ctx, "Write spec", "high", { due: { "#utc": iso(-3) } }); // overdue
  const design = await addTodo(ctx, "Design API", "high", { due: { "#utc": iso(-1) } }); // overdue
  const build = await addTodo(ctx, "Build", "med", { due: { "#utc": iso(5) } }); // future
  const ship = await addTodo(ctx, "Ship", "high"); // no due
  ok((await listTodos(ctx)).length === 4, "4 todos created; old schema fields still work");

  h("Overdue (field predicate `< due now`)");
  const od = await overdue(ctx, iso(0));
  ok(od.length === 2 && od.map((r) => r.id).includes(spec), "2 overdue todos (spec, design), future/no-due excluded");

  h("Tags as edge entities (real membership, single add/remove)");
  await addTag(ctx, spec, "urgent");
  await addTag(ctx, spec, "docs");
  await addTag(ctx, design, "urgent");
  await addTag(ctx, spec, "urgent"); // idempotent
  ok((await tagsOf(ctx, spec)).join(",") === "docs,urgent", "spec has tags [docs, urgent]");
  ok((await todosByTag(ctx, "urgent")).length === 2, "2 todos tagged urgent");
  await removeTag(ctx, spec, "docs");
  ok((await tagsOf(ctx, spec)).join(",") === "urgent", "removing one tag leaves the others");

  h("Dependencies as edge entities: Ship <- Build <- Design <- Spec");
  await addDependency(ctx, build, design);
  await addDependency(ctx, build, spec);
  await addDependency(ctx, ship, build);
  // complete spec + design so Build's blockers shrink
  await setStatus(ctx, spec, "done");

  h("Blocked / Ready (dependency graph joins)");
  let bl = (await blocked(ctx)).map((r) => r.title).sort();
  ok(bl.join(",") === "Build,Ship", "Build (design open) and Ship (build open) are blocked");
  let rd = (await ready(ctx)).map((r) => r.title).sort();
  ok(rd.includes("Design API") && !rd.includes("Build"), "Design API is ready; Build is not");

  await setStatus(ctx, design, "done"); // now Build's blockers are all done
  bl = (await blocked(ctx)).map((r) => r.title).sort();
  ok(bl.join(",") === "Ship", "after finishing Design, only Ship stays blocked");
  rd = (await ready(ctx)).map((r) => r.title).sort();
  ok(rd.includes("Build"), "Build becomes ready once its blockers are done");

  console.log(`\n\x1b[1m${fail === 0 ? "\x1b[32mALL PASS" : "\x1b[31mFAILURES"}\x1b[0m  ${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
