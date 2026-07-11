// Seed a clean database with an interactive dataset for the web UI.
//   node src/seed-demo.ts     (point STARDUST_URL at the fresh DB)

import { addDependency } from "./features.ts";
import { addTodo, setStatus } from "./todos.ts";
import { createWorkspace } from "./tenancy.ts";
import { runToFixpoint } from "./workflow.ts";
import { defaultWorkspace, openWorkspace } from "./workspace.ts";

async function main() {
  const ctx = await defaultWorkspace(); // the "Default" workspace the web UI opens

  // A few standalone todos.
  await addTodo(ctx, "Buy coffee beans", "high");
  await addTodo(ctx, "Reply to Ada's email", "med");
  const read = await addTodo(ctx, "Read the Stardust docs", "low");
  await setStatus(ctx, read, "doing");

  // A dependency chain — the workflow will mark the later steps "blocked".
  // Uncheck-proof: blocked rows can't be toggled until their blockers finish.
  const design = await addTodo(ctx, "① Design landing page", "high");
  const build = await addTodo(ctx, "② Build landing page", "high");
  const qa = await addTodo(ctx, "③ QA landing page", "med");
  const launch = await addTodo(ctx, "④ Launch landing page", "high");
  await addDependency(ctx, build, design);
  await addDependency(ctx, qa, build);
  await addDependency(ctx, launch, qa);

  // A second workspace so the switcher has somewhere to go.
  const groceries = await createWorkspace(ctx.personaId, "Groceries");
  const gctx = await openWorkspace(ctx.personaId, groceries.id);
  await addTodo(gctx, "Milk", "med");
  await addTodo(gctx, "Eggs", "med");
  await addTodo(gctx, "Sourdough", "low");

  // Run the workflow once so initial "blocked" statuses are materialized.
  const applied = await runToFixpoint("seed");
  console.log(`seeded. workflow set ${applied} initial status change(s).`);
  console.log("Default workspace: 3 standalone + a 4-step blocked chain.");
  console.log("Groceries workspace: 3 items.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
