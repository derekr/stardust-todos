// Provision this app's named reactors into a Stardust database.
//
//   STARDUST_URL=http://localhost:1981 node scripts/setup.ts   # npm run stardust:setup
//
// Idempotent and safe to re-run: each reactor is created under its name, updated
// if its definition has drifted since, or left alone. Run it after changing a
// reactor body — the app provisions on boot too, but doing it explicitly means a
// deploy fails here rather than on a user's first request.

import { type Provisioned, ensureReactor } from "../src/reactors.ts";
import { KEYED_FIELDS, ensureValueIndex } from "../src/indexes.ts";
import { ensureSchema } from "../src/registry.ts";
import { DECLARED } from "../src/queries.ts";
import { DECLARED_SCHEMAS } from "../src/schemas.ts";
import { BOARD_REACTOR, canonicalBody } from "../src/session.ts";
import { ensureTodoSchema } from "../src/todos.ts";
import { BASE } from "../src/stardust.ts";

// The board reactor is provisioned directly (it is hand-written, not a declared
// query); everything else provisions itself from the query catalog.
const REACTORS: { name: string; provision: () => Promise<Provisioned> }[] = [
  { name: BOARD_REACTOR, provision: () => ensureReactor(BOARD_REACTOR, canonicalBody()) },
  ...DECLARED.map((d) => ({ name: d.name, provision: () => d.provision() })),
];

const MARK = {
  created: "\x1b[32m+ created\x1b[0m",
  updated: "\x1b[33m~ updated\x1b[0m",
  current: "\x1b[2m= current\x1b[0m",
};

async function main() {
  console.log(`stardust ${BASE}\n`);
  // Schemas first: they are write boundaries the reactors' data is written through.
  await ensureTodoSchema();
  console.log(`  ${MARK.current}  schema todo`);
  for (const s of DECLARED_SCHEMAS) {
    await ensureSchema(s.name, s.doc);
    console.log(`  ${MARK.current}  schema ${s.name}`);
  }
  for (const r of REACTORS) {
    const { id, status } = await r.provision();
    console.log(`  ${MARK[status]}  ${r.name.padEnd(12)} #${id}`);
  }
  // Value indexes last: they are policy over fields the reactors above match on,
  // and a rebuild reads canonical facts, so there is nothing to gain by doing it
  // before the queries that need it exist.
  for (const f of KEYED_FIELDS) {
    const state = await ensureValueIndex(f);
    console.log(`  ${state === "enabled" ? MARK.created : MARK.current}  index ${f}`);
  }
  console.log("\nreactors provisioned.");
}

main().catch((e) => {
  console.error(`\n\x1b[31msetup failed:\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
