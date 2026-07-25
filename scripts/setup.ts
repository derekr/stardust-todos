// Provision this app's named reactors into a Stardust database.
//
//   STARDUST_URL=http://localhost:1981 node scripts/setup.ts   # npm run stardust:setup
//
// Idempotent and safe to re-run: each reactor is created under its name, updated
// if its definition has drifted since, or left alone. Run it after changing a
// reactor body — the app provisions on boot too, but doing it explicitly means a
// deploy fails here rather than on a user's first request.

import { ensureReactor } from "../src/reactors.ts";
import { BOARD_REACTOR, canonicalBody } from "../src/session.ts";
import { BASE } from "../src/stardust.ts";

const REACTORS = [{ name: BOARD_REACTOR, body: canonicalBody }] as const;

const MARK = { created: "\x1b[32m+ created\x1b[0m", updated: "\x1b[33m~ updated\x1b[0m", current: "\x1b[2m= current\x1b[0m" };

async function main() {
  console.log(`stardust ${BASE}\n`);
  for (const r of REACTORS) {
    const { id, status } = await ensureReactor(r.name, r.body());
    console.log(`  ${MARK[status]}  ${r.name.padEnd(12)} #${id}`);
  }
  console.log("\nreactors provisioned.");
}

main().catch((e) => {
  console.error(`\n\x1b[31msetup failed:\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
