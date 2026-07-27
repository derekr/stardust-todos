// Provision this app's named reactors into a Stardust database.
//
//   STARDUST_URL=http://localhost:1981 node scripts/setup.ts   # npm run stardust:setup
//
// Idempotent and safe to re-run: each reactor is created under its name, updated
// if its definition has drifted since, or left alone. Run it after changing a
// reactor body — the app provisions on boot too, but doing it explicitly means a
// deploy fails here rather than on a user's first request.

import type { Provisioned } from "../src/reactors.ts";
import { KEYED_FIELDS, TEXT_FIELDS, ensureTextIndex, ensureValueIndex } from "../src/indexes.ts";
import { ensureSchema } from "../src/registry.ts";
import { DECLARED } from "../src/queries.ts";
import { DECLARED_SCHEMAS } from "../src/schemas.ts";
import { ensureTodoSchema } from "../src/todos.ts";
import { BASE } from "../src/stardust.ts";

// Everything provisions itself from the query catalog now. The four hand-written
// `board*` reactors used to be provisioned here as well — one per body SHAPE, the
// tag `exists` and the wall-clock `overdue` clauses compiled in or out — and they
// are gone. The board's rows are a dry-run whose body inlines the session's
// selected facet values, so the body is a function of the FILTER and there is no
// finite set of shapes to store. What keeps the board live is `session-page`,
// which is a declared query like the rest.
const REACTORS: { name: string; provision: () => Promise<Provisioned> }[] = DECLARED.map((d) => ({
  name: d.name,
  provision: () => d.provision(),
}));

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
    console.log(`  ${MARK[status]}  ${r.name.padEnd(18)} #${id}`);
  }
  // Value indexes last: they are policy over fields the reactors above match on,
  // and a rebuild reads canonical facts, so there is nothing to gain by doing it
  // before the queries that need it exist.
  for (const f of KEYED_FIELDS) {
    const state = await ensureValueIndex(f);
    console.log(`  ${state === "enabled" ? MARK.created : MARK.current}  index ${f}`);
  }
  // Text indexes last of all, because enabling one BACKFILLS: the PATCH does not
  // return until the analyzer has read every existing text revision of the field
  // (3.6s over the demo's 10,003 titles). Until it has, a search fails closed
  // rather than answering short — so this line finishing is what makes the blocker
  // picker's typeahead work, and it is the one step here that is slow on purpose.
  for (const f of TEXT_FIELDS) {
    const state = await ensureTextIndex(f);
    console.log(`  ${state === "enabled" ? MARK.created : MARK.current}  text index ${f} (english)`);
  }
  console.log("\nreactors provisioned.");
}

main().catch((e) => {
  console.error(`\n\x1b[31msetup failed:\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
