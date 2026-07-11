// Stage 2 proof: projects + duplication with atomic dependency-ref remapping.
//
//   node src/demo-projects.ts

import { addDependency, blocked } from "./features.ts";
import { addTag, tagsOf } from "./features.ts";
import { addTodo, setStatus } from "./todos.ts";
import { createProject, duplicateProject, listProjects, projectTodos } from "./projects.ts";
import { createPersona, createWorkspace, ensureUser } from "./tenancy.ts";
import { openWorkspace } from "./workspace.ts";

const tag = `p${Date.now().toString().slice(-6)}`;
let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${m}`);
  c ? pass++ : fail++;
};
const h = (s: string) => console.log(`\n\x1b[1m\x1b[36m${s}\x1b[0m`);

async function main() {
  const user = await ensureUser(`proj.${tag}@example.test`);
  const persona = await createPersona(user, `P ${tag}`);
  const ws = await createWorkspace(persona, `Proj ${tag}`);
  const ctx = await openWorkspace(persona, ws.id);

  h("Build a 'Launch' project template with a dependency chain");
  const launch = await createProject(ctx, `Launch ${tag}`);
  const design = await addTodo(ctx, "Design", "high", { project: { "#": launch } });
  const build = await addTodo(ctx, "Build", "high", { project: { "#": launch } });
  const test = await addTodo(ctx, "Test", "med", { project: { "#": launch } });
  await addDependency(ctx, build, design); // build needs design
  await addDependency(ctx, test, build); // test needs build
  await addTag(ctx, design, "milestone");
  await setStatus(ctx, design, "done"); // make progress on the ORIGINAL
  ok((await projectTodos(ctx, launch)).length === 3, "Launch has 3 todos");

  h("Duplicate the project (fresh copy, remapped dependencies)");
  const copy = await duplicateProject(ctx, launch, `Launch COPY ${tag}`);
  ok((await listProjects(ctx)).length === 2, "now 2 projects");
  const copyTodos = await projectTodos(ctx, copy);
  ok(copyTodos.length === 3, "copy has 3 todos");

  const copyIds = new Set(copyTodos.map((t) => t.id));
  const origIds = new Set([design, build, test]);
  ok([...copyIds].every((id) => !origIds.has(id)), "copy todos are brand-new entities (not shared)");

  h("Dependencies were rewired to the COPY, not left pointing at the original");
  // In the copy: Design done? No — progress was reset. So Build & Test are blocked,
  // and every blocked todo in the copy must be a COPY todo, never an original.
  const bl = await blocked(ctx);
  const copyBlocked = bl.filter((r) => copyIds.has(r.id)).map((r) => r.title).sort();
  ok(copyBlocked.join(",") === "Build,Test", "copy's Build+Test are blocked by copy's own todos");
  const leak = bl.some((r) => copyIds.has(r.id) === false && r.title === "Build" && !origIds.has(r.id));
  ok(!leak, "no dependency in the copy points back at an original todo");

  h("Progress is reset in the copy; original is untouched");
  const designCopy = copyTodos.find((t) => t.title === "Design")!;
  ok((await tagsOf(ctx, designCopy.id)).includes("milestone"), "tags were cloned onto the copy");
  // original Design stays done; copy Design is fresh todo -> copy has 3 open, blocked shows 2
  ok(copyBlocked.length === 2, "copy starts fresh: Build+Test blocked because copy-Design is not done");

  console.log(`\n\x1b[1m${fail === 0 ? "\x1b[32mALL PASS" : "\x1b[31mFAILURES"}\x1b[0m  ${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
