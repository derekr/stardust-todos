// Runtime validation mechanics, showcased end to end.
//   STARDUST_URL=http://localhost:1990 node src/demo-validation.ts
//
// The compile-time checker (see typed-query.ts) proves a query is WELL-FORMED.
// But there's a network boundary and — this is the crucial part — Stardust's
// schema only guards the SCHEMA write route. A plain `transact` writes
// OPEN-WORLD: it will happily store `status: "archived"` even though the Todo
// schema's enum is todo|doing|blocked|done. So the data on the wire can drift
// from the types the compiler believes. The runtime validator is what catches
// that drift at the read boundary — using the SAME validators generated from
// the schema.

import { query, validationPlan } from "./typed-query.ts";
import { transact, deleteEntity } from "./stardust.ts";
import { defaultWorkspace } from "./workspace.ts";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const d = (s: string) => `\x1b[2m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;

// The one query we validate throughout — a plain-JSON projection of status.
const APP = "validation-demo";
const statusQuery = {
  find: ["?t", "?title", "?status"],
  where: [
    ["?t", "app", APP],
    ["?t", "title", "?title"],
    ["?t", "status", "?status"],
  ],
  then: { project: { id: "?t", title: "?title", status: "?status" } },
} as const;

async function main() {
  await defaultWorkspace(); // ensure the DB is seeded/reachable

  // -----------------------------------------------------------------------
  // 1. The MECHANISM, made inspectable. validationPlan() is exactly what
  //    query() runs internally: walk `where` to bind each ?var to its field,
  //    then map each projected key to that field's generated validator.
  // -----------------------------------------------------------------------
  console.log(d("\n1 — the validation plan is DERIVED from the query + the schema field map"));
  const plan = validationPlan(statusQuery.where, statusQuery.then.project);
  for (const c of plan) {
    console.log(
      `   project key ${y(c.key.padEnd(7))} → field ${y(c.field.padEnd(8))} → ${c.field === "@id" ? "isNumber" : "schema validator"}`,
    );
  }
  console.log(d(`   (id←?t is a subject var → entity id; title/status ← object vars → their field types)`));

  // A clean todo written through the OPEN-WORLD path but with valid values.
  const good = await transact({
    "#_ok": { app: APP, title: "ship the release", status: "doing" },
  });
  const goodId = good.tempIds!.ok;

  // -----------------------------------------------------------------------
  // 2. Control: valid data flows through, typed and validated.
  // -----------------------------------------------------------------------
  console.log(d("\n2 — valid data passes the boundary and comes back typed"));
  const rows = await query(statusQuery);
  for (const row of rows) console.log(`   ${g("✓")} #${row.id} ${row.title} [${row.status}]`);

  // -----------------------------------------------------------------------
  // 3. Now DRIFT the data. `transact` bypasses the schema, so this write of an
  //    out-of-enum status SUCCEEDS at the engine — no schema route, no guard.
  // -----------------------------------------------------------------------
  console.log(d("\n3 — open-world write drifts status to a value the schema forbids"));
  const bad = await transact({
    "#_drift": { app: APP, title: "archived leftover", status: "archived" },
  });
  const badId = bad.tempIds!.drift;
  console.log(
    `   ${y("wrote")} #${badId} with status ${r('"archived"')} via plain transact (engine accepted it — no schema on this route)`,
  );

  // -----------------------------------------------------------------------
  // 4. The SAME query now returns a drifted row. The compiler still believes
  //    status is the enum — only the runtime validator can catch this.
  // -----------------------------------------------------------------------
  console.log(d("\n4 — the identical typed query REJECTS the drift at the read boundary"));
  try {
    const badRows = await query(statusQuery);
    console.log(r(`   ✗ validation did NOT fire — got ${badRows.length} rows unchecked`));
  } catch (e) {
    console.log(`   ${g("✓ threw:")} ${(e as Error).message}`);
    console.log(d("     ↑ the enum validator generated from the Todo schema rejected the row"));
  }

  // Cleanup — remove both throwaway entities.
  await deleteEntity(goodId);
  await deleteEntity(badId);
  console.log(g("\n   ✓ boundary held: compile-time shape + runtime schema validator, one source of truth\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
