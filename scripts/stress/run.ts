// Stress + invariant harness for the board reactor.
//
//   STARDUST_URL=http://127.0.0.1:3095 node scripts/stress/run.ts --n 1000000
//
// Point it at a THROWAWAY server: it writes an adversarial corpus and a session
// per configuration. The query under test is the app's own canonicalBody(),
// imported rather than copied, so this exercises what ships.
//
// Six questions, in increasing cost:
//   1. data loss  — is every todo written still there, with every fact it needs?
//   2. invariants — metamorphic relations that hold whatever the data is
//   3. oracle     — does the board agree with the SPEC, row for row?
//   4. derivation — do the STORED derived fields agree with the plain query?
//   5. write paths — do they still agree after an adversarial write sequence?
//   6. the clock  — does `overdue` answer for NOW, or for a literal frozen into the
//                   reactor when it was provisioned? (It was the latter, for weeks.)
// Plus timings, because a query that is right at 10k and unusable at 1M is a bug —
// including the tag body, which is the one that still runs a subquery and so is the
// one that still has a ceiling.
//
// Two harness rules learned the hard way. Facet writes APPEND, so every
// configuration gets a FRESH session rather than a mutated one — otherwise the
// join multiplies and the harness invents its own duplicates. And the unfiltered
// board at a million rows is a ~200MB response, so it is measured, never parsed.
//
// There is no longer ONE board body: the app compiles the tag `exists` and the
// wall-clock overdue clauses out when a session does not need them, so this creates
// one reactor per shape and reads whichever the app would have read for the same
// filter. Getting that wrong here would silently test a body nobody runs.
//
// 4 and 5 ask something different from the rest. `blocked` is a STORED fact now,
// maintained by the app's write paths rather than by the query, so its correctness
// is a property of code that runs on WRITE — no amount of reading proves it. So 5
// drives the app's own commands through a sequence built out of the transitions a
// materialized flag gets wrong, and asks after EVERY step whether the stored answer
// still equals the plain query's. Both directions of that were verified to fail
// when a single `refreshDerived` call is removed, which is the only evidence that
// the property is load-bearing rather than decorative.

import { type BoardShape, canonicalBody } from "../../src/session.ts";
import { BASE as APP_BASE, readEntity } from "../../src/stardust.ts";
import { addTodo, reconcileBlocked, removeTodo, setDone, setStatus, toggleTodo } from "../../src/todos.ts";
import { addDependency, removeDependency } from "../../src/features.ts";
import { createPersona, createWorkspace, ensureUser } from "../../src/tenancy.ts";
import { openWorkspace } from "../../src/workspace.ts";
import { PRIORITY, STATUS, type Facets, blocked, effectiveStatus, expectedCount, expectedSet, prank } from "./model.ts";
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
  // The write-path phase calls the APP's commands, and those resolve their own
  // base URL at import time. If the two disagree the harness would quietly test a
  // different database than it seeded — so it refuses instead.
  if (APP_BASE !== BASE) {
    console.error(`\x1b[31mSTARDUST_URL must be set: the app points at ${APP_BASE}, the harness at ${BASE}\x1b[0m\n`);
    process.exit(1);
  }

  console.log("\x1b[1mseed\x1b[0m");
  const t0 = Date.now();
  const s = await seed(BASE, N);
  const secs = (Date.now() - t0) / 1000;
  console.log(`  seeded in ${secs.toFixed(1)}s (${Math.round(N / secs).toLocaleString()} todos/s)\n`);

  await createReactors();
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
      `[?t title ?ti] [?t done ?d] [?t draft ?dr] [?t author ?a] [?t lastActor ?la] ` +
      `[?t blocked ?bl] [?t effectiveStatus ?es] [?t prank ?pr]]`,
  );
  // Twelve, not nine: the board JOINS the three derived facts now, and a fact
  // clause a row has never been written skips that row in silence. A todo missing
  // `prank` does not sort oddly — it disappears.
  ok("every todo has all twelve board facts", complete === N, `${complete.toLocaleString()} / ${N.toLocaleString()}`);

  // ---- 2. invariants -----------------------------------------------------
  console.log("\n\x1b[1minvariants\x1b[0m");
  const hi: Facets = { ...full, priority: ["high"], status: ["todo"] };
  const lo: Facets = { ...full, priority: ["low"], status: ["todo"] };
  const both: Facets = { ...full, priority: ["high", "low"], status: ["todo"] };

  const sidHi = await sessionFor(hi);
  const sidLo = await sessionFor(lo);
  const sidBoth = await sessionFor(both);

  const rHi = await board(hi, sidHi);
  if (!rHi) {
    ok("the board query executes at all", false, lastError);
    console.log("\n  \x1b[33mthe engine refused the query — every check below it is unreachable\x1b[0m");
    console.log(`\n\x1b[31m${failures} failing\x1b[0m\n`);
    process.exit(1);
  }
  const rHi2 = await board(hi, sidHi);
  ok("repeat read is stable", !!rHi2 && same(rHi.rows.map(kOf), rHi2.rows.map(kOf)));
  ok("no duplicate ids", new Set(rHi.rows.map((r) => r.id)).size === rHi.rows.length, `${rHi.rows.length} rows`);

  const rLo = (await board(lo, sidLo))!;
  ok(
    "a session sees only its own filter",
    rLo.rows.every((r) => r.priority === "low"),
  );
  ok(
    "...and the other still sees only its own",
    rHi.rows.every((r) => r.priority === "high"),
  );

  const rBoth = (await board(both, sidBoth))!;
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
    const got = await board(f, sid);
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

  // per-row values, on a bounded slice. These are PROJECTIONS of stored facts now,
  // not derivations — so this asks whether the corpus's recorded consequences match
  // the spec, which is the same question section 4 asks over the whole corpus.
  const hiAll: Facets = { ...full, priority: ["high"] };
  const slice = (await board(hiAll, await sessionFor(hiAll)))?.rows ?? [];
  ok(
    "effectiveStatus agrees with the spec",
    slice.every((r) => r.effectiveStatus === effectiveStatus(kOf(r))),
    `${slice.length.toLocaleString()} rows`,
  );
  ok(
    "blocked agrees with the spec",
    slice.every((r) => r.blocked === blocked(kOf(r))),
    "joined from the stored fact",
  );

  // Ordering is the whole reason `prank` exists: ascending prank is high→med→low,
  // where the priority STRING sorted high, low, med. The tiebreaker matters as much
  // — equal keys make an offset drop and repeat rows — so the assertion is over the
  // full (prank, title) key, not just the first component.
  const sortedFull = (await board(full, await sessionFor(full)))?.rows ?? [];
  let ordered = true;
  for (let i = 1; i < Math.min(sortedFull.length, 200_000); i++) {
    const a = sortedFull[i - 1]!,
      b = sortedFull[i]!;
    const pa = prank(kOf(a)),
      pb = prank(kOf(b));
    if (pb < pa || (pb === pa && b.title < a.title)) ordered = false;
  }
  ok("rows are ordered by priority rank, then title", ordered, "orderBy [?prank ?title ?t]");

  // ---- 4. the stored derivation, and the write paths that maintain it -----
  console.log("\n\x1b[1mderived fields (stored on write, not derived on read)\x1b[0m");
  const carried = await count(
    `find[[count ?t]] where[[?t app todo-app] [?t workspace ${ws}] [?t blocked ?b] ` +
      `[?t effectiveStatus ?e] [?t prank ?p]]`,
  );
  ok(
    "every seeded todo carries all three derived facts",
    carried === N,
    `${carried.toLocaleString()} / ${N.toLocaleString()}`,
  );

  // The corpus, as seeded, against the spec — bounded to the rows a dep edge
  // touches, which is the only place blocked-ness is interesting and is N/100.
  const linked = await dry<[number, string, string, boolean, number]>({
    find: ["?t", "?ti", "?es", "?bl", "?pr"],
    where: [
      ["?d", "kind", "dep"],
      ["?d", "todo", "?t"],
      ["?t", "title", "?ti"],
      ["?t", "effectiveStatus", "?es"],
      ["?t", "blocked", "?bl"],
      ["?t", "prank", "?pr"],
    ],
  });
  ok(
    "stored effectiveStatus agrees with the spec on every dep-linked todo",
    linked.length > 0 && linked.every(([, ti, es]) => es === effectiveStatus(kFromTitle(ti))),
    `${linked.length.toLocaleString()} rows`,
  );
  ok(
    "stored blocked agrees with the spec on every dep-linked todo",
    linked.every(([, ti, , bl]) => bl === blocked(kFromTitle(ti))),
  );
  ok(
    "stored prank is the priority ORDINAL (high 0, med 1, low 2)",
    linked.every(([, ti, , , pr]) => pr === prank(kFromTitle(ti))),
  );

  const tRec = Date.now();
  const corpusDiv = await reconcileBlocked(s.workspace);
  ok(
    "reconcileBlocked over the whole corpus finds no divergence",
    corpusDiv.length === 0,
    `${Date.now() - tRec}ms over ${N.toLocaleString()} todos` +
      (corpusDiv.length
        ? ` · ${corpusDiv
            .slice(0, 3)
            .map((d) => `#${d.id} ${d.stored}!=${d.actual}`)
            .join(", ")}`
        : ""),
  );

  // ---- 5. the same invariant under an adversarial write sequence ----------
  //
  // Every step below is a real app command in its own workspace, and after each
  // one the stored `blocked` set is compared against the plain open-blocker query
  // — the harness asking Stardust directly, not trusting the app's own guard —
  // plus effectiveStatus and prank on each row the sequence touches. The sequence
  // is chosen for the transitions that a materialized flag gets WRONG: a blocker
  // finishing and then reopening, one of two blockers finishing, an edge being
  // retracted rather than satisfied, and a blocker being deleted outright.
  console.log("\n\x1b[1madversarial write sequence (the phase-1 invariant)\x1b[0m");
  // Its own workspace, minted through tenancy rather than defaultWorkspace(): the
  // latter runs migrateOrphanTodos on first creation, whose `not` clause is a
  // SUBQUERY with a per-directive cap of 1000 rows, so it refuses outright once a
  // corpus this size is in the database. Unrelated to what is under test here, but
  // worth knowing that `not` does not scale the way a fact clause does.
  const user = await ensureUser("stress@local");
  const persona = await createPersona(user, `stress ${Date.now()}`);
  const ctx = await openWorkspace(persona, (await createWorkspace(persona, "adversarial")).id);
  const A = await addTodo(ctx, "adv A (blocker)", "high", {}, "Owner");
  const B = await addTodo(ctx, "adv B (blocker)", "med", {}, "Owner");
  const C = await addTodo(ctx, "adv C", "low", {}, "Owner");
  const D = await addTodo(ctx, "adv D", "high", {}, "Owner");
  const touched = [A, B, C, D];
  const ordinal: Record<string, number> = { high: 0, med: 1, low: 2 };

  const steps: [string, () => Promise<unknown>][] = [
    ["add dep C→A", () => addDependency(ctx, C, A)],
    ["complete the blocker A", () => setDone(ctx, A, true, "Owner")],
    ["reopen the blocker A", () => setDone(ctx, A, false, "Owner")],
    ["add a SECOND blocker C→B", () => addDependency(ctx, C, B)],
    ["complete one of the two (B)", () => setStatus(ctx, B, "done", "Owner")],
    ["retract the other edge C→A", () => removeDependency(ctx, C, A)],
    ["add dep D→C", () => addDependency(ctx, D, C)],
    ["toggle C done", () => toggleTodo(ctx, C, "Owner")],
    ["toggle C back to open", () => toggleTodo(ctx, C, "Owner")],
    ["add dep D→A (two blockers again)", () => addDependency(ctx, D, A)],
    ["DELETE the blocker A", () => removeTodo(ctx, A)],
    ["complete the last blocker C", () => setStatus(ctx, C, "done", "Owner")],
  ];

  for (const [label, run] of steps) {
    await run();
    ok(label, ...(await derivedHolds(ctx.workspaceId, touched, ordinal)));
  }

  // ---- 6. `overdue` against the real clock --------------------------------
  //
  // The corpus's overdue todos are all due in 2020, which any plausible `now`
  // clears — so the oracle above cannot tell a live clock from a dead one. The
  // board used to hold a literal `{#utc 2026-07-11…}` baked in when the reactor was
  // provisioned, and it had been silently wrong for weeks by the time it was found.
  // This is the regression test for it: a todo due THREE DAYS AGO is overdue under a
  // clock and invisible under any literal older than that. It is written after every
  // count above, so it cannot perturb them.
  console.log("\n\x1b[1moverdue reads the wall clock\x1b[0m");
  const day = 86_400_000;
  const recent = await freshTodo(s, "recent due", NOW - 3 * day);
  const future = await freshTodo(s, "future due", NOW + 30 * day);
  const odFacets: Facets = { ...full, view: "overdue" };
  const od = await board(odFacets, await sessionFor(odFacets));
  ok("a todo due three days ago is overdue", !!od && od.rows.some((r) => r.id === recent), `#${recent}`);
  ok("a todo due next month is not", !!od && !od.rows.some((r) => r.id === future), `#${future}`);

  // ---- 7. performance ----------------------------------------------------
  console.log("\n\x1b[1mperformance\x1b[0m");
  const wide = await raw(full, await sessionFor(full));
  console.log(
    `  unfiltered board   ${String(wide.ms).padStart(6)}ms   ${(wide.bytes / 1048576).toFixed(1)}MB   ` +
      `expected ${expectedCount(N, full, NOW).toLocaleString()} rows`,
  );
  const narrowPerf = await raw(hi, sidHi);
  console.log(
    `  narrow slice       ${String(narrowPerf.ms).padStart(6)}ms   ${(narrowPerf.bytes / 1024).toFixed(0)}KB`,
  );

  // The tag body is the one that still runs a correlated `exists`, so it still has a
  // ceiling: roughly "however many rows reach the clause", which is why it is placed
  // last. Measured, not asserted — this is where the remaining limit IS, and it
  // moves with the corpus.
  for (const [label, f] of [
    ["tag + narrow facets", { ...full, priority: ["high"], tagActive: true, tags: ["alpha"] } as Facets],
    ["tag + every facet", { ...full, tagActive: true, tags: ["alpha"] } as Facets],
  ] as const) {
    const sid = await sessionFor(f);
    const got = await board(f, sid);
    console.log(
      got
        ? `  ${label.padEnd(18)} ${String(got.ms).padStart(6)}ms   ${got.rows.length.toLocaleString()} rows`
        : `  ${label.padEnd(18)} \x1b[33mrefused\x1b[0m — ${lastError}`,
    );
  }

  console.log(`\n${failures ? `\x1b[31m${failures} failing\x1b[0m` : "\x1b[32mall green\x1b[0m"}\n`);
  process.exit(failures ? 1 : 0);
}

const kFromTitle = (title: string) => Number(title.slice("stress ".length));
const kOf = (r: BoardRow) => kFromTitle(r.title);
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const idOf = (v: unknown) => (typeof v === "number" ? v : (v as { "#": number })["#"]);

/** A one-shot dry-run in JSON. Throws on a refusal rather than returning junk. */
async function dry<T>(body: unknown): Promise<T[]> {
  const res = await fetch(`${BASE}/reactors/dry-run`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const parsed = JSON.parse((await res.text()).trim().split("\n")[0] ?? "[]");
  if (parsed && parsed["stardust/error"]) throw new Error(String(parsed.message));
  return parsed as T[];
}

/**
 * Does the STORED derivation still match what the engine says, right now?
 *
 * Deliberately not routed through the app's own helpers: the plain open-blocker
 * query is issued here, and the stored facts are read here, so this can catch a
 * write path and its guard being wrong in the same way. `reconcileBlocked` is then
 * asked as well, because it is the check that ships and it should agree.
 */
async function derivedHolds(
  ws: number,
  touched: number[],
  ordinal: Record<string, number>,
): Promise<[boolean, string]> {
  const open = new Set(
    (
      await dry<[unknown]>({
        find: ["?t"],
        where: [
          ["?d", "kind", "dep"],
          ["?d", "todo", "?t"],
          ["?d", "blocker", "?b"],
          ["?b", "status", "?bs"],
          ["!=", "?bs", "done"],
        ],
      })
    ).map(([t]) => idOf(t)),
  );
  const stored = await dry<[number, boolean]>({
    find: ["?t", "?blocked"],
    where: [
      ["?t", "app", "todo-app"],
      ["?t", "workspace", { "#": ws }],
      ["?t", "blocked", "?blocked"],
    ],
  });
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const [id, b] of stored) {
    seen.add(id);
    if (b !== open.has(id)) problems.push(`#${id} blocked=${b} but the query says ${open.has(id)}`);
  }
  for (const id of touched) {
    const e = await readEntity(id);
    if (typeof e.status !== "string") continue; // deleted by an earlier step
    if (!seen.has(id)) problems.push(`#${id} carries no blocked fact`);
    const want = open.has(id) && e.status !== "done" ? "blocked" : e.status;
    if (e.effectiveStatus !== want) problems.push(`#${id} effectiveStatus=${e.effectiveStatus} want ${want}`);
    const wantRank = ordinal[e.priority as string];
    if (e.prank !== wantRank) problems.push(`#${id} prank=${e.prank} want ${wantRank}`);
  }
  const shipped = await reconcileBlocked(ws);
  if (shipped.length) problems.push(`reconcileBlocked reported ${shipped.length} divergence(s)`);
  return [problems.length === 0, problems.slice(0, 3).join(" · ")];
}

// ---------------------------------------------------------------------------
// One reactor per body SHAPE, because the app has one per shape: the tag `exists`
// and the wall-clock overdue clauses are compiled out when a session does not need
// them. The harness picks the same body the app would pick for the same filter, so
// a configuration that reads the wrong one is a bug here, not a wrong answer.
// ---------------------------------------------------------------------------
const shapeOf = (f: Facets): BoardShape => ({ tag: f.tagActive, overdue: f.view === "overdue" });
const shapeKey = (s: BoardShape) => `${s.overdue}|${s.tag}`;
const rids = new Map<string, number>();

async function createReactors(): Promise<void> {
  for (const shape of [
    { tag: false, overdue: false },
    { tag: true, overdue: false },
    { tag: false, overdue: true },
    { tag: true, overdue: true },
  ] as BoardShape[]) {
    const res = await fetch(`${BASE}/reactors`, {
      method: "POST",
      headers: H,
      body: JSON.stringify(canonicalBody(shape)),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`reactor: ${res.status} ${text.slice(0, 200)}`);
    const rec = JSON.parse(text.trim().split("\n")[0]!);
    rids.set(shapeKey(shape), typeof rec.reactorId === "object" ? rec.reactorId["#"] : rec.reactorId);
  }
  console.log(`\x1b[1mboard reactors\x1b[0m ${[...rids.entries()].map(([k, v]) => `${k} #${v}`).join("  ")}\n`);
}

/** The results URL for a configuration: the right body, and `now` when it needs one. */
function resultsUrl(f: Facets, sid: number): string {
  const shape = shapeOf(f);
  const bind = shape.overdue ? `{sid ${sid} now {#utc '${new Date(NOW).toISOString()}'}}` : `{sid ${sid}}`;
  return `${BASE}/reactors/${rids.get(shapeKey(shape))}/results?max=1&bind=${encodeURIComponent(bind)}`;
}

async function raw(f: Facets, sid: number): Promise<{ ms: number; bytes: number }> {
  const t0 = Date.now();
  const res = await fetch(resultsUrl(f, sid), { headers: { Accept: "application/x-ndjson" } });
  let bytes = 0;
  for await (const chunk of res.body!) bytes += (chunk as Uint8Array).length;
  return { ms: Date.now() - t0, bytes };
}

/** null when the engine refused the query — recorded as a failure, not a crash. */
async function board(f: Facets, sid: number): Promise<{ rows: BoardRow[]; ms: number } | null> {
  const t0 = Date.now();
  const res = await fetch(resultsUrl(f, sid), { headers: { Accept: "application/x-ndjson" } });
  const text = await res.text();
  const parsed = JSON.parse(text.trim().split("\n")[0] ?? "[]");
  if (parsed && parsed["stardust/error"]) {
    lastError = String(parsed.message);
    return null;
  }
  return { rows: parsed as BoardRow[], ms: Date.now() - t0 };
}

/**
 * One extra todo in the corpus's workspace, due at `due`. Written the way the seed
 * writes them — including the three derived facts, because a row missing any of them
 * does not sort oddly on the board, it disappears.
 */
async function freshTodo(s: Awaited<ReturnType<typeof seed>>, title: string, due: number): Promise<number> {
  const res = await fetch(`${BASE}/commands/transact`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      "#_t": {
        kind: "todo",
        app: "todo-app",
        workspace: { "#": s.workspace },
        title: `clock ${title}`,
        status: "todo",
        priority: "high",
        done: false,
        draft: false,
        author: { "#": s.owner },
        lastActor: "seed",
        due: { "#utc": new Date(due).toISOString() },
        blocked: false,
        effectiveStatus: "todo",
        prank: 0,
      },
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`clock todo: ${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(body).tempIds.t as number;
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
