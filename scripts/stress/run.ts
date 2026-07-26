// Stress + invariant harness for the board reactor.
//
//   STARDUST_URL=http://127.0.0.1:3095 node scripts/stress/run.ts --n 1000000
//
// Point it at a THROWAWAY server: it writes an adversarial corpus and a session
// per configuration. The query under test is the app's own canonicalBody(),
// imported rather than copied, so this exercises what ships.
//
// Three questions, in increasing cost:
//   1. data loss  — is every todo written still there, with every fact it needs?
//   2. invariants — metamorphic relations that hold whatever the data is
//   3. oracle     — does the board agree with the SPEC, row for row?
// Plus timings, because a query that is right at 10k and unusable at 1M is a bug.
//
// Two harness rules learned the hard way. Facet writes APPEND, so every
// configuration gets a FRESH session rather than a mutated one — otherwise the
// join multiplies and the harness invents its own duplicates. And the unfiltered
// board at a million rows is a ~200MB response, so it is measured, never parsed.

import { canonicalBody } from "../../src/session.ts";
import { PRIORITY, STATUS, type Facets, effectiveStatus, expectedCount, expectedSet, overdue } from "./model.ts";
import { seed, session } from "./seed.ts";

const BASE = process.env.STARDUST_URL ?? "http://127.0.0.1:3095";
const H = { Accept: "application/x-ndjson", "Content-Type": "application/json" };
const NOW = Date.now();

const argv = process.argv.slice(2);
const N = (() => {
  const i = argv.indexOf("--n");
  return i === -1 ? 10_000 : Number(argv[i + 1]);
})();

let failures = 0;
function ok(name: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(
    `  ${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`,
  );
}

interface BoardRow {
  id: number;
  title: string;
  status: string;
  priority: string;
  effectiveStatus: string;
  blocked: boolean;
  overdue: boolean;
}

const full: Facets = {
  status: STATUS,
  priority: PRIORITY,
  tags: [],
  tagActive: false,
  view: "all",
  viewerIsOwner: true,
  actor: "Owner",
};

let nextSid = 900_000;
let lastError = "";

async function main() {
  console.log(`\n\x1b[1mstress: ${N.toLocaleString()} todos against ${BASE}\x1b[0m\n`);

  console.log("\x1b[1mseed\x1b[0m");
  const t0 = Date.now();
  const s = await seed(BASE, N);
  const secs = (Date.now() - t0) / 1000;
  console.log(`  seeded in ${secs.toFixed(1)}s (${Math.round(N / secs).toLocaleString()} todos/s)\n`);

  const rid = await createReactor();
  const sessionFor = async (f: Facets) => {
    const sid = ++nextSid;
    await session(s, sid, f);
    return sid;
  };

  // ---- 1. data loss ------------------------------------------------------
  console.log("\x1b[1mdata loss\x1b[0m");
  const ws = `{# ${s.workspace}}`;
  const present = await count(`find[[count ?t]] where[[?t app todo-app] [?t workspace ${ws}]]`);
  ok("every seeded todo is present", present === N, `${present.toLocaleString()} / ${N.toLocaleString()}`);
  const complete = await count(
    `find[[count ?t]] where[[?t app todo-app] [?t workspace ${ws}] [?t status ?s] [?t priority ?p] ` +
      `[?t title ?ti] [?t done ?d] [?t draft ?dr] [?t author ?a] [?t lastActor ?la]]`,
  );
  ok("every todo has all nine board facts", complete === N, `${complete.toLocaleString()} / ${N.toLocaleString()}`);

  // ---- 2. invariants -----------------------------------------------------
  console.log("\n\x1b[1minvariants\x1b[0m");
  const hi: Facets = { ...full, priority: ["high"], status: ["todo"] };
  const lo: Facets = { ...full, priority: ["low"], status: ["todo"] };
  const both: Facets = { ...full, priority: ["high", "low"], status: ["todo"] };

  const sidHi = await sessionFor(hi);
  const sidLo = await sessionFor(lo);
  const sidBoth = await sessionFor(both);

  const rHi = await board(rid, sidHi);
  if (!rHi) {
    ok("the board query executes at all", false, lastError);
    console.log("\n  \x1b[33mthe engine refused the query — every check below it is unreachable\x1b[0m");
    console.log(`\n\x1b[31m${failures} failing\x1b[0m\n`);
    process.exit(1);
  }
  const rHi2 = await board(rid, sidHi);
  ok("repeat read is stable", !!rHi2 && same(rHi.rows.map(kOf), rHi2.rows.map(kOf)));
  ok("no duplicate ids", new Set(rHi.rows.map((r) => r.id)).size === rHi.rows.length, `${rHi.rows.length} rows`);

  const rLo = (await board(rid, sidLo))!;
  ok(
    "a session sees only its own filter",
    rLo.rows.every((r) => r.priority === "low"),
  );
  ok(
    "...and the other still sees only its own",
    rHi.rows.every((r) => r.priority === "high"),
  );

  const rBoth = (await board(rid, sidBoth))!;
  const setBoth = new Set(rBoth.rows.map(kOf));
  const setUnion = new Set([...rHi.rows.map(kOf), ...rLo.rows.map(kOf)]);
  ok(
    "R(high) ∪ R(low) == R(high,low)",
    setBoth.size === setUnion.size && [...setUnion].every((k) => setBoth.has(k)),
    `${setBoth.size.toLocaleString()} vs ${setUnion.size.toLocaleString()}`,
  );
  ok("widening a facet never shrinks the result", setBoth.size >= rHi.rows.length);

  // ---- 3. oracle ---------------------------------------------------------
  console.log("\n\x1b[1moracle (written from the spec, not the implementation)\x1b[0m");
  for (const [label, f] of [
    ["priority=high status=todo", hi],
    ["view=ready", { ...hi, view: "ready" } as Facets],
    ["view=done", { ...full, priority: ["high"], status: STATUS, view: "done" } as Facets],
    ["view=overdue", { ...full, priority: ["high"], status: STATUS, view: "overdue" } as Facets],
    ["view=mine", { ...full, priority: ["high"], status: STATUS, view: "mine" } as Facets],
    ["viewer=member (drafts)", { ...hi, viewerIsOwner: false } as Facets],
    ["tagActive alpha", { ...full, priority: ["high"], status: STATUS, tagActive: true, tags: ["alpha"] } as Facets],
  ] as const) {
    const sid = await sessionFor(f);
    const got = await board(rid, sid);
    if (!got) {
      ok(label, false, lastError);
      continue;
    }
    const want = new Set(expectedSet(N, f, NOW));
    const gotK = new Set(got.rows.map(kOf));
    const missing = [...want].filter((k) => !gotK.has(k));
    const extra = [...gotK].filter((k) => !want.has(k));
    ok(
      label,
      missing.length === 0 && extra.length === 0,
      `got ${gotK.size.toLocaleString()} want ${want.size.toLocaleString()}` +
        (missing.length ? ` · missing ${missing.slice(0, 3).join(",")}` : "") +
        (extra.length ? ` · extra ${extra.slice(0, 3).join(",")}` : ""),
    );
  }

  // per-row derivations, on a bounded slice
  const sidHiAll = await sessionFor({ ...full, priority: ["high"] });
  const slice = (await board(rid, sidHiAll))?.rows ?? [];
  ok(
    "effectiveStatus agrees with the spec",
    slice.every((r) => r.effectiveStatus === effectiveStatus(kOf(r))),
    `${slice.length.toLocaleString()} rows`,
  );
  ok(
    "blocked agrees with the spec",
    slice.every((r) => r.blocked === (effectiveStatus(kOf(r)) === "blocked" || (r.status === "done" && r.blocked))),
    "derived via a bound exists",
  );
  ok(
    "overdue agrees with the spec",
    slice.every((r) => r.overdue === overdue(kOf(r), NOW)),
    "a `now` frozen at provision time shows up here",
  );

  const rank = (p: string) => PRIORITY.indexOf(p as (typeof PRIORITY)[number]);
  const sortedFull = (await board(rid, await sessionFor(full)))?.rows ?? [];
  let ordered = true;
  for (let i = 1; i < Math.min(sortedFull.length, 200_000); i++) {
    if (rank(sortedFull[i]!.priority) < rank(sortedFull[i - 1]!.priority)) ordered = false;
  }
  ok("rows are ordered by priority rank", ordered, "orderBy sorts the STRING");

  // ---- 4. performance ----------------------------------------------------
  console.log("\n\x1b[1mperformance\x1b[0m");
  const wide = await raw(rid, await sessionFor(full));
  console.log(
    `  unfiltered board   ${String(wide.ms).padStart(6)}ms   ${(wide.bytes / 1048576).toFixed(1)}MB   ` +
      `expected ${expectedCount(N, full, NOW).toLocaleString()} rows`,
  );
  const narrowPerf = await raw(rid, sidHi);
  console.log(
    `  narrow slice       ${String(narrowPerf.ms).padStart(6)}ms   ${(narrowPerf.bytes / 1024).toFixed(0)}KB`,
  );

  console.log(`\n${failures ? `\x1b[31m${failures} failing\x1b[0m` : "\x1b[32mall green\x1b[0m"}\n`);
  process.exit(failures ? 1 : 0);
}

const kOf = (r: BoardRow) => Number(r.title.slice("stress ".length));
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

async function createReactor(): Promise<number> {
  const res = await fetch(`${BASE}/reactors`, { method: "POST", headers: H, body: JSON.stringify(canonicalBody()) });
  const text = await res.text();
  if (!res.ok) throw new Error(`reactor: ${res.status} ${text.slice(0, 200)}`);
  const rec = JSON.parse(text.trim().split("\n")[0]!);
  const id = typeof rec.reactorId === "object" ? rec.reactorId["#"] : rec.reactorId;
  console.log(`\x1b[1mboard reactor #${id}\x1b[0m (the app's canonicalBody)\n`);
  return id;
}

async function raw(rid: number, sid: number): Promise<{ ms: number; bytes: number }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/reactors/${rid}/results?max=1&bind=${encodeURIComponent(`{sid ${sid}}`)}`, {
    headers: { Accept: "application/x-ndjson" },
  });
  let bytes = 0;
  for await (const chunk of res.body!) bytes += (chunk as Uint8Array).length;
  return { ms: Date.now() - t0, bytes };
}

/** null when the engine refused the query — recorded as a failure, not a crash. */
async function board(rid: number, sid: number): Promise<{ rows: BoardRow[]; ms: number } | null> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/reactors/${rid}/results?max=1&bind=${encodeURIComponent(`{sid ${sid}}`)}`, {
    headers: { Accept: "application/x-ndjson" },
  });
  const text = await res.text();
  const parsed = JSON.parse(text.trim().split("\n")[0] ?? "[]");
  if (parsed && parsed["stardust/error"]) {
    lastError = String(parsed.message);
    return null;
  }
  return { rows: parsed as BoardRow[], ms: Date.now() - t0 };
}

async function count(ron: string): Promise<number> {
  const res = await fetch(`${BASE}/reactors/dry-run`, {
    method: "POST",
    headers: { Accept: "application/x-ndjson", "Content-Type": "application/ron" },
    body: ron,
  });
  const rows = JSON.parse((await res.text()).trim().split("\n")[0]!);
  return rows?.[0]?.[0] ?? 0;
}

await main();
