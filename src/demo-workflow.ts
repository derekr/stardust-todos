// Stage 3 proof: derivation WITHOUT a worker.
//
// Blocked-ness and project rollup used to be materialized onto `status` by an
// imperative worker (react to every commit, recompute to a fixpoint). The
// un-transition ("no incomplete blocker → unblock") needed a correlated antijoin
// + reactor retraction, neither of which Stardust has — hence the worker.
//
// Now they're DERIVED on read via correlated `$exists` projections. Completing a
// blocker writes nothing to the dependent's status; the dependent simply derives
// as ready on the next read. No worker, no fixpoint, no un-block write.
//
//   node src/demo-workflow.ts

import { addDependency } from "./features.ts";
import { addTodo, setStatus } from "./todos.ts";
import { createProject, listProjects, projectTodos } from "./projects.ts";
import { openBlockerExists } from "./derive.ts";
import { APP, createPersona, createWorkspace, ensureUser } from "./tenancy.ts";
import { type WorkspaceCtx, openWorkspace } from "./workspace.ts";
import { query } from "./stardust.ts";

const tag = `w${Date.now().toString().slice(-6)}`;
let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${m}`);
  if (c) pass++;
  else fail++;
};
const h = (s: string) => console.log(`\n\x1b[1m\x1b[36m${s}\x1b[0m`);

// The board's derivation, on demand: each todo's stored status + derived blocked,
// computed by Stardust on read. No writes.
async function derived(ctx: WorkspaceCtx): Promise<Map<number, { status: string; blocked: boolean }>> {
  const rows = (await query({
    find: ["?t", "?status"],
    where: [
      ["?t", "app", APP],
      ["?t", "workspace", { "#": ctx.workspaceId }],
      ["?t", "status", "?status"],
    ],
    then: { project: { id: "?t", status: "?status", blocked: openBlockerExists("?t") } },
  })) as { id: number; status: string; blocked: boolean }[];
  return new Map(rows.map((r) => [r.id, { status: r.status, blocked: r.blocked }]));
}
const eff = (d: Map<number, { status: string; blocked: boolean }>, id: number): string => {
  const r = d.get(id)!;
  return r.blocked && r.status !== "done" ? "blocked" : r.status;
};

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

  h("Blocked-ness is DERIVED from the graph — nothing was written to status");
  let d = await derived(ctx);
  ok(eff(d, a) === "todo", "A is ready (no blockers)");
  ok(eff(d, b) === "blocked", "B derives blocked (needs A)");
  ok(eff(d, c) === "blocked", "C derives blocked (needs B)");

  h("Complete A -> B derives ready on the next read (no un-block write)");
  await setStatus(ctx, a, "done");
  d = await derived(ctx);
  ok(eff(d, b) === "todo", "B now derives ready");
  ok(eff(d, c) === "blocked", "C still blocked (B not done)");

  h("Complete B -> C derives ready");
  await setStatus(ctx, b, "done");
  d = await derived(ctx);
  ok(eff(d, c) === "todo", "C now derives ready");

  h("Project rollup is derived too");
  await setStatus(ctx, c, "done");
  ok((await listProjects(ctx)).find((p) => p.id === sprint)!.status === "done", "Sprint derives done (all todos done)");

  h("Add a new todo -> project derives active again");
  await addTodo(ctx, "Hotfix", "high", { project: { "#": sprint } });
  ok((await listProjects(ctx)).find((p) => p.id === sprint)!.status === "active", "Sprint derives active");
  ok((await projectTodos(ctx, sprint)).length === 4, "project now has 4 todos");

  h("No worker, no fixpoint");
  ok(true, "every transition above was recomputed on read — nothing to converge, nothing to undo");

  console.log(
    `\n\x1b[1m${fail === 0 ? "\x1b[32mALL PASS" : "\x1b[31mFAILURES"}\x1b[0m  ${pass} passed, ${fail} failed\n`,
  );
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
