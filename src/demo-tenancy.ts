// Proves the user -> persona -> workspace isolation end to end.
//
//   node src/demo-tenancy.ts        (STARDUST_URL defaults to http://localhost:1981)
//
// Scenario:
//   alice (user) has two personas: "Personal" and "Work".
//   bob (user)   has one persona:  "Bob".
//   Alice/Personal owns  workspace "Household".
//   Alice/Work     owns  workspace "Acme"  and SHARES it with Bob (member grant).
//   Bob            owns  workspace "Bob Solo".
// We then assert that each workspace sees only its own todos, that Bob is
// denied Household, and that the shared Acme is visible to both.

import {
  AccessDenied,
  createPersona,
  createWorkspace,
  ensureUser,
  grantAccess,
  listPersonas,
  listWorkspaces,
} from "./tenancy.ts";
import { addTodo, listTodos } from "./todos.ts";
import { openWorkspace } from "./workspace.ts";

const tag = `t${Date.now().toString().slice(-6)}`; // unique-ish per run
let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${msg}`);
  if (cond) pass++;
  else fail++;
};
const h = (s: string) => console.log(`\n\x1b[1m\x1b[36m${s}\x1b[0m`);

async function main() {
  h("1. Users and personas");
  const alice = await ensureUser(`alice.${tag}@example.test`);
  const bob = await ensureUser(`bob.${tag}@example.test`);
  const aPersonal = await createPersona(alice, `Personal ${tag}`);
  const aWork = await createPersona(alice, `Work ${tag}`);
  const bob1 = await createPersona(bob, `Bob ${tag}`);
  ok((await listPersonas(alice)).length === 2, "alice has 2 personas");
  ok((await listPersonas(bob)).length === 1, "bob has 1 persona");

  h("2. Workspaces and grants");
  const household = await createWorkspace(aPersonal, `Household ${tag}`);
  const acme = await createWorkspace(aWork, `Acme ${tag}`);
  const bobSolo = await createWorkspace(bob1, `Bob Solo ${tag}`);
  await grantAccess(acme.id, bob1, "member"); // share Acme with Bob
  ok((await listWorkspaces(aPersonal)).length === 1, "Alice/Personal sees 1 workspace (Household)");
  ok((await listWorkspaces(aWork)).length === 1, "Alice/Work sees 1 workspace (Acme)");
  const bobWs = await listWorkspaces(bob1);
  ok(bobWs.length === 2, "Bob sees 2 workspaces (Bob Solo + shared Acme)");

  h("3. Add todos inside each workspace (through access-checked contexts)");
  const houseCtx = await openWorkspace(aPersonal, household.id);
  const acmeCtx = await openWorkspace(aWork, acme.id);
  const bobCtx = await openWorkspace(bob1, bobSolo.id);
  await addTodo(houseCtx, "Buy groceries", "high");
  await addTodo(houseCtx, "Pay rent", "high");
  await addTodo(acmeCtx, "Ship Q3 release", "high");
  await addTodo(acmeCtx, "Write launch post", "med");
  await addTodo(bobCtx, "Bob: renew domain", "low");
  console.log(`  Household: ${(await listTodos(houseCtx)).map((t) => t.title).join(", ")}`);
  console.log(`  Acme     : ${(await listTodos(acmeCtx)).map((t) => t.title).join(", ")}`);
  console.log(`  Bob Solo : ${(await listTodos(bobCtx)).map((t) => t.title).join(", ")}`);

  h("4. Isolation: each workspace sees only its own todos");
  const houseIds = new Set((await listTodos(houseCtx)).map((t) => t.id));
  const acmeIds = new Set((await listTodos(acmeCtx)).map((t) => t.id));
  const bobIds = new Set((await listTodos(bobCtx)).map((t) => t.id));
  const disjoint = (a: Set<number>, b: Set<number>) => [...a].every((x) => !b.has(x));
  ok((await listTodos(houseCtx)).length === 2, "Household has exactly its 2 todos");
  ok((await listTodos(acmeCtx)).length === 2, "Acme has exactly its 2 todos");
  ok(
    disjoint(houseIds, acmeIds) && disjoint(houseIds, bobIds) && disjoint(acmeIds, bobIds),
    "no todo id appears in two workspaces",
  );

  h("5. Access control: Bob cannot open Alice's Household");
  let denied = false;
  try {
    await openWorkspace(bob1, household.id);
  } catch (e) {
    denied = e instanceof AccessDenied;
  }
  ok(denied, "openWorkspace(Bob, Household) throws AccessDenied");

  h("6. Sharing: Bob CAN open the shared Acme and sees its todos");
  const bobOnAcme = await openWorkspace(bob1, acme.id);
  const bobAcmeIds = new Set((await listTodos(bobOnAcme)).map((t) => t.id));
  ok(
    [...acmeIds].every((x) => bobAcmeIds.has(x)),
    "Bob sees the same todos in shared Acme as Alice/Work",
  );
  ok(disjoint(bobAcmeIds, houseIds), "shared Acme still does not expose Household");

  h("7. Write isolation: Bob cannot toggle a Household todo via his Acme ctx");
  const [houseTodo] = await listTodos(houseCtx);
  let writeBlocked = false;
  try {
    const { toggleTodo } = await import("./todos.ts");
    await toggleTodo(bobOnAcme, houseTodo.id); // wrong-workspace id
  } catch {
    writeBlocked = true;
  }
  ok(writeBlocked, "toggling a Household todo through Acme ctx is rejected");

  console.log(
    `\n\x1b[1m${fail === 0 ? "\x1b[32mALL PASS" : "\x1b[31mFAILURES"}\x1b[0m  ${pass} passed, ${fail} failed\n`,
  );
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
