// Stage 3 proof: durable workflows as event-driven dataflow.
// Derivation rules materialize `status` from the dependency graph and close/
// reopen projects. We drive runToFixpoint() explicitly for determinism; in
// production startWorker() runs the same rules on every transaction event.
//
//   node src/demo-workflow.ts

import { addDependency } from "./features.ts";
import { addTodo, setStatus } from "./todos.ts";
import { createProject, projectTodos } from "./projects.ts";
import { runToFixpoint } from "./workflow.ts";
import { createPersona, createWorkspace, ensureUser } from "./tenancy.ts";
import { openWorkspace } from "./workspace.ts";
import { readEntity } from "./stardust.ts";

const tag = `w${Date.now().toString().slice(-6)}`;
let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${m}`);
  c ? pass++ : fail++;
};
const h = (s: string) => console.log(`\n\x1b[1m\x1b[36m${s}\x1b[0m`);
const statusOf = async (id: number) => (await readEntity(id)).status as string;

async function main() {
  const user = await ensureUser(`wf.${tag}@example.test`);
  const persona = await createPersona(user, `P ${tag}`);
  const ws = await createWorkspace(persona, `WF ${tag}`);
  const ctx = await openWorkspace(persona, ws.id);

  h("Sprint project: A <- B <- C (chain)");
  const sprint = await createProject(ctx, `Sprint ${tag}`);
  const a = await addTodo(ctx, "A", "high", { project: { "#": sprint } });
  const b = await addTodo(ctx, "B", "high", { project: { "#": sprint } });
  const c = await addTodo(ctx, "C", "med", { project: { "#": sprint } });
  await addDependency(ctx, b, a);
  await addDependency(ctx, c, b);

  h("Workflow materializes blocked status from the graph");
  await runToFixpoint("demo");
  ok((await statusOf(a)) === "todo", "A is ready (no blockers)");
  ok((await statusOf(b)) === "blocked", "B auto-blocked (needs A)");
  ok((await statusOf(c)) === "blocked", "C auto-blocked (needs B)");

  h("Complete A -> workflow auto-unblocks B (causation-linked write)");
  await setStatus(ctx, a, "done");
  await runToFixpoint(`user-finished-A`);
  ok((await statusOf(b)) === "todo", "B auto-unblocked");
  ok((await statusOf(c)) === "blocked", "C still blocked (B not done)");

  h("Complete B -> C unblocks");
  await setStatus(ctx, b, "done");
  await runToFixpoint("user-finished-B");
  ok((await statusOf(c)) === "todo", "C auto-unblocked");

  h("Complete C -> project auto-closes");
  await setStatus(ctx, c, "done");
  await runToFixpoint("user-finished-C");
  ok((await statusOf(sprint)) === "done", "Sprint project auto-closed (all todos done)");

  h("Add a new todo -> project auto-reopens");
  await addTodo(ctx, "Hotfix", "high", { project: { "#": sprint } });
  await runToFixpoint("user-added-todo");
  ok((await statusOf(sprint)) === "active", "Sprint project auto-reopened");
  ok((await projectTodos(ctx, sprint)).length === 4, "project now has 4 todos");

  h("Idempotence / convergence");
  const applied = await runToFixpoint("noop");
  ok(applied === 0, "re-running the workflow applies 0 changes (fixpoint reached)");

  console.log(`\n\x1b[1m${fail === 0 ? "\x1b[32mALL PASS" : "\x1b[31mFAILURES"}\x1b[0m  ${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
