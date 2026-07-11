// End-to-end proof of the "search session in Stardust" model — ONE canonical
// reactor computes effectiveStatus + applies every filter server-side.
//   STARDUST_URL=http://localhost:1990 node src/demo-session.ts

import { createSession, readSnapshot, sessionWrite, setFilter } from "./session.ts";
import { emptyFilter } from "./board.ts";
import { defaultWorkspace } from "./workspace.ts";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${msg}`);
  if (cond) pass++;
  else fail++;
};
const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

async function main() {
  const ctx = await defaultWorkspace();
  const h = await createSession(ctx.workspaceId, ctx.personaId, "seed");
  console.log(`session ${h.sessionId} · ALL filtering server-side in one reactor\n`);

  console.log("\x1b[36mDefault filter = everything\x1b[0m");
  let snap = await readSnapshot(h);
  ok(snap.length >= 7, `snapshot has all seeded todos (${snap.length})`);
  ok(
    snap.every((t) => "effectiveStatus" in t && "blocked" in t),
    "rows carry server-computed effectiveStatus + blocked",
  );

  console.log("\x1b[36mStatus filter → [blocked] (filters on DERIVED effective status)\x1b[0m");
  await setFilter(h, { ...emptyFilter, status: ["blocked"] }, "seed");
  snap = await readSnapshot(h);
  ok(
    snap.every((t) => t.effectiveStatus === "blocked"),
    `only effective-blocked rows: ${ids(snap).join(",")}`,
  );
  ok(snap.length === 3, "exactly the 3 blocked todos (224,226,228)");

  console.log("\x1b[36mView → ready (todo AND not blocked, server-side)\x1b[0m");
  await setFilter(h, { ...emptyFilter, view: "ready" }, "seed");
  snap = await readSnapshot(h);
  ok(
    snap.every((t) => t.effectiveStatus === "todo") && !snap.some((t) => t.blocked),
    `ready = not-blocked todos: ${ids(snap).join(",")}`,
  );

  console.log("\x1b[36mPriority filter → [high]\x1b[0m");
  await setFilter(h, { ...emptyFilter, priority: ["high"] }, "seed");
  snap = await readSnapshot(h);
  ok(snap.length > 0 && snap.every((t) => t.priority === "high"), `only high priority (${snap.length})`);

  console.log("\x1b[36mWrite carries the session: sessionWrite() refreshes the snapshot\x1b[0m");
  await setFilter(h, { ...emptyFilter }, "seed"); // back to all
  snap = await readSnapshot(h);
  const blockedRow = snap.find((t) => t.blocked);
  if (!blockedRow) {
    ok(false, "expected a blocked todo in the seed");
  } else {
    const { query } = await import("./stardust.ts");
    const rows = (await query({
      find: ["?b"],
      where: [
        ["?d", "kind", "dep"],
        ["?d", "todo", { "#": blockedRow.id }],
        ["?d", "blocker", "?b"],
      ],
    })) as [{ "#": number } | number][];
    const blockerId = typeof rows[0][0] === "number" ? rows[0][0] : (rows[0][0] as { "#": number })["#"];
    await sessionWrite(h, { [blockerId]: { status: "done", done: true } });
    const fresh = await readSnapshot(h);
    const same = fresh.find((t) => t.id === blockedRow.id);
    ok(
      same !== undefined && same.blocked === false,
      `todo ${blockedRow.id} now UNblocked after a session-carrying write`,
    );
  }

  console.log(`\n${fail === 0 ? "\x1b[32mALL PASS\x1b[0m" : "\x1b[31mFAILED\x1b[0m"}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
