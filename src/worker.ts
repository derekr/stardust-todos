// Runnable durable-workflow worker. Subscribes to Stardust's transaction event
// bus and runs the derivation rules on every commit (auto block/unblock todos,
// auto close/reopen projects), tagging each derived write with the causing tx.
//
//   node src/worker.ts        (leave running alongside the app)

import { startWorker } from "./workflow.ts";

const ac = new AbortController();
process.on("SIGINT", () => {
  ac.abort();
  process.exit(0);
});

console.log("workflow worker running — reacting to committed transactions (Ctrl-C to stop)");
await startWorker(ac.signal, (txId, applied) => {
  if (applied) console.log(`tx ${txId} -> applied ${applied} derived change(s)`);
});
