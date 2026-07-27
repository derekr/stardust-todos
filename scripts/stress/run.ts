// Stress + invariant harness for the board reactor.
//
//   STARDUST_URL=http://127.0.0.1:3095 node scripts/stress/run.ts --n 1000000
//
// Point it at a THROWAWAY server: it writes an adversarial corpus and asks the
// app's own canonicalBody() for every board, imported rather than copied, so this
// exercises what ships.
//
// Eight questions, in increasing cost:
//   1. data loss  — is every todo written still there, with every fact it needs?
//   2. invariants — metamorphic relations that hold whatever the data is
//   3. oracle     — does the board agree with the SPEC, row for row?
//   4. derivation — do the STORED derived fields agree with the plain query?
//   5. write paths — do they still agree after an adversarial write sequence?
//   5b. tags      — the same question for the OTHER thing stored twice: does a
//                   todo's `tags` component still equal its tag edges after every
//                   add, every remove, and a delete that outlives its edges?
//   6. the clock  — does `overdue` answer for NOW, or for a literal frozen into the
//                   reactor when it was provisioned? (It was the latter, for weeks.)
//   7. paging     — do the WINDOWS of a body tile the body? The board returns one
//                   page now, so "the board agrees with the spec" only means
//                   something if the pages a reader walks add up to it.
//   8. inline==join — does the body that INLINES the selected facet values return
//                   exactly what the body that JOINED them off a session returned?
//                   That is the change this section exists to hold down, and it is
//                   asked against the engine rather than against the oracle, so a
//                   spec and an implementation being wrong together cannot hide it.
// Plus timings, because a query that is right at 10k and unusable at 1M is a bug.
// The tag body used to be the exception on that list — the last correlated subquery,
// and the only clause with a ceiling of its own. It has neither now, and sections 3
// and 5b are what keep the replacement honest: the same rows, and the two places a
// label is stored still agreeing after every write.
//
// One harness rule learned the hard way: the unfiltered board at a million rows is
// a ~200MB response, so it is measured, never parsed. (The other one — a FRESH
// session per configuration, because facet writes append and a mutated session
// multiplies the join — is gone with the sessions. Section 8 still writes one, for
// the one comparison that needs a session to join against.)
//
// Every board read here is a DRY-RUN of `canonicalBody`, which is what the app does
// now. It used to create one stored reactor per body SHAPE and read whichever the
// app would have read for the same filter; there are no shapes any more, because
// the body inlines the selection and so varies with the filter itself.
//
// 4 and 5 ask something different from the rest. `blocked` is a STORED fact now,
// maintained by the app's write paths rather than by the query, so its correctness
// is a property of code that runs on WRITE — no amount of reading proves it. So 5
// drives the app's own commands through a sequence built out of the transitions a
// materialized flag gets wrong, and asks after EVERY step whether the stored answer
// still equals the plain query's. Both directions of that were verified to fail
// when a single `refreshDerived` call is removed, which is the only evidence that
// the property is load-bearing rather than decorative.

import {
  type BoardQuery,
  type BoardScope,
  PAGE_SIZE,
  type PageWindow,
  canonicalBody,
  facetClauses,
  pageWindow,
} from "../../src/board-query.ts";
import { BASE as APP_BASE, readEntity } from "../../src/stardust.ts";
import { addTodo, reconcileBlocked, removeTodo, setDone, setStatus, toggleTodo } from "../../src/todos.ts";
import { addDependency, addTag, removeDependency, removeTag, tagsOf } from "../../src/features.ts";
import { reconcileTags } from "../../src/tags.ts";
import { createPersona, createWorkspace, ensureUser } from "../../src/tenancy.ts";
import { type WorkspaceCtx, openWorkspace } from "../../src/workspace.ts";
import {
  PRIORITY,
  STATUS,
  type Facets,
  blocked,
  effectiveStatus,
  expectedCount,
  expectedSet,
  prank,
  row as model,
} from "./model.ts";
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

// Section 8 is the only thing that still writes a session, and it writes one per
// comparison so the value-join it reconstructs has something to join to. A `sid`
// selects a session by VALUE, so two entities carrying the same one are both
// matched and every row comes back twice; the base is the clock so that a re-run
// against a database this harness has already touched is a different run.
let nextSid = 900_000 + (Date.now() % 90_000_000);
let lastError = "";

/** Todos the CLOCK phase writes into the corpus's workspace (section 6). The
 *  oracle is a pure function of N and cannot see them, so anything that compares a
 *  whole-corpus count against it after section 6 has to add them back. */
const CLOCK_TODOS = 2;

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

  // The BoardScope every configuration is read in — the half of the board's inputs
  // a browser never supplies, and which used to be facts on the session.
  SCOPE = {
    owner: { workspace: s.workspace, viewer: s.owner, actor: "Owner" },
    member: { workspace: s.workspace, viewer: s.member, actor: "Owner" },
  };

  /** A session entity for section 8, which reconstructs the value-join. */
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
  // The tag COMPONENT is the thirteenth, and it is optional by design — only the
  // todos the model gives labels to carry one. Counted separately for that reason,
  // and against the model rather than against N: a todo whose labels never reached
  // the component is not a todo that filters oddly, it is one the tag filter cannot
  // see at all.
  const withTags = await count(`find[[count ?t]] where[[?t app todo-app] [?t workspace ${ws}] [?t tags ?tags]]`);
  let modelTagged = 0;
  for (let k = 0; k < N; k++) if (model(k).tags.length) modelTagged++;
  ok(
    "every todo the model tags carries the tag component",
    withTags === modelTagged,
    `${withTags.toLocaleString()} / ${modelTagged.toLocaleString()}`,
  );

  // ---- 2. invariants -----------------------------------------------------
  console.log("\n\x1b[1minvariants\x1b[0m");
  const hi: Facets = { ...full, priority: ["high"], status: ["todo"] };
  const lo: Facets = { ...full, priority: ["low"], status: ["todo"] };
  const both: Facets = { ...full, priority: ["high", "low"], status: ["todo"] };

  const rHi = await board(hi);
  if (!rHi) {
    ok("the board query executes at all", false, lastError);
    console.log("\n  \x1b[33mthe engine refused the query — every check below it is unreachable\x1b[0m");
    console.log(`\n\x1b[31m${failures} failing\x1b[0m\n`);
    process.exit(1);
  }
  const rHi2 = await board(hi);
  ok("repeat read is stable", !!rHi2 && same(rHi.rows.map(kOf), rHi2.rows.map(kOf)));
  ok("no duplicate ids", new Set(rHi.rows.map((r) => r.id)).size === rHi.rows.length, `${rHi.rows.length} rows`);

  // Kept, and worth saying what it means NOW. It used to prove that a value-join
  // correlated to `?sess` could not pick up ANOTHER session's facet rows — a
  // cross-tenant leak. There are no sessions to leak between; what it proves today
  // is that a body compiled from one selection returns only rows matching that
  // selection, which is the failure a compiler can plausibly introduce and a join
  // could not.
  const rLo = (await board(lo))!;
  ok(
    "a compiled filter returns only its own rows",
    rLo.rows.every((r) => r.priority === "low"),
  );
  ok(
    "...and a differently compiled one only its own",
    rHi.rows.every((r) => r.priority === "high"),
  );

  const rBoth = (await board(both))!;
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
    // Two labels and three, because the number of labels is exactly what the old
    // subquery could not survive: its OUTPUT was capped at 1,000 rows per
    // directive, so two labels passed, three refused, and the app rendered the
    // refusal as an empty board. The membership test that replaced it is one
    // expression over a set literal, so these three cases are the same query with a
    // bigger set — and the union property below says so directly.
    ["tagActive alpha,beta", { ...full, tagActive: true, tags: ["alpha", "beta"] } as Facets],
    [
      "tagActive alpha,beta,gamma (one unused)",
      { ...full, tagActive: true, tags: ["alpha", "beta", "gamma"] } as Facets,
    ],
  ] as const) {
    const got = await board(f);
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
  const slice = (await board(hiAll))?.rows ?? [];
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
  const sortedFull = (await board(full))?.rows ?? [];
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
  // latter also runs the boot backfills, which would scan the whole corpus for
  // nothing. (They used to REFUSE at this size — their `not` clause was a subquery
  // with a per-directive cap of 1000 rows — which is what the set-difference
  // rewrite in todos.ts fixed.)
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

  // ---- 5b. the SAME kind of invariant for tags ----------------------------
  //
  // A todo's labels are stored twice now — as `tag` edge entities and as a `tags`
  // list component on the todo — because the board can filter on the component and
  // could not filter on the edges (a correlated `exists` whose output is capped at
  // 1,000 rows per directive: 82.7s for one label and a REFUSAL for three, rendered
  // as an empty board). That buys a filter that works and gives up an invariant, so
  // it gets the same treatment `blocked` got: every step below is a real app
  // command, and after each one the two representations are compared — by the app's
  // own guard AND by reading the component back.
  //
  // The last step is the one that is easy to get wrong in the guard rather than in
  // the write path: deleting a todo leaves its tag edges behind, pointing at a dead
  // id, and a reconciliation that does not require the todo to still exist reports
  // that as a missing component forever.
  console.log("\n\x1b[1mtag writes (the component must equal the edges)\x1b[0m");
  const T1 = await addTodo(ctx, "tag subject one", "high", {}, "Owner");
  const T2 = await addTodo(ctx, "tag subject two", "med", {}, "Owner");
  const tagSteps: [string, () => Promise<unknown>, number[]][] = [
    ["add alpha", () => addTag(ctx, T1, "alpha"), [T1]],
    ["add alpha again (idempotent)", () => addTag(ctx, T1, "alpha"), [T1]],
    ["add beta beside it", () => addTag(ctx, T1, "beta"), [T1]],
    ["a second todo takes alpha", () => addTag(ctx, T2, "alpha"), [T1, T2]],
    ["remove alpha from the first", () => removeTag(ctx, T1, "alpha"), [T1, T2]],
    ["remove a label it does not have", () => removeTag(ctx, T1, "alpha"), [T1, T2]],
    ["remove its last label", () => removeTag(ctx, T1, "beta"), [T1, T2]],
    ["DELETE a tagged todo (edges outlive it)", () => removeTodo(ctx, T2), [T1]],
  ];
  for (const [label, run, live] of tagSteps) {
    await run();
    ok(label, ...(await tagsHold(ctx, ctx.workspaceId, live)));
  }
  // And the board itself, in that workspace: the filter finds the row by its label,
  // once, and stops finding it when the label is removed.
  const tagBoard = async (labels: string[]) =>
    (
      await runBoard(
        canonicalBody(
          {
            workspace: ctx.workspaceId,
            viewer: persona,
            actor: "Owner",
            status: [],
            priority: [],
            tags: labels,
            view: "all",
            now: new Date(NOW),
          },
          null,
        ),
      )
    )?.rows ?? [];
  await addTag(ctx, T1, "alpha");
  await addTag(ctx, T1, "beta");
  const twoLabels = await tagBoard(["alpha", "beta"]);
  ok(
    "a todo carrying BOTH selected labels appears exactly once",
    twoLabels.filter((r) => r.id === T1).length === 1,
    `${twoLabels.length} row(s) for two labels`,
  );
  await removeTag(ctx, T1, "alpha");
  const gone = await tagBoard(["alpha"]);
  ok("removing the label removes it from that filtered board", !gone.some((r) => r.id === T1), `${gone.length} row(s)`);
  const still = await tagBoard(["beta"]);
  ok(
    "...and leaves it on the board for the label it kept",
    still.some((r) => r.id === T1),
    `${still.length} row(s)`,
  );

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
  const future = await freshTodo(s, "future due", NOW + 30 * day); // CLOCK_TODOS of them
  const odFacets: Facets = { ...full, view: "overdue" };
  const od = await board(odFacets);
  ok("a todo due three days ago is overdue", !!od && od.rows.some((r) => r.id === recent), `#${recent}`);
  ok("a todo due next month is not", !!od && !od.rows.some((r) => r.id === future), `#${future}`);

  // ---- 7. paging ---------------------------------------------------------
  //
  // The board returns ONE PAGE now, so "does the board agree with the spec" is no
  // longer enough: the question is whether the pages a reader walks through add up
  // to the answer the oracle checked. Three properties say they do, and they are
  // the ones that catch an unstable sort — which is why `orderBy` ends with the
  // entity id. Without that tiebreaker two rows with equal (prank, title) may come
  // back in either order, and a page boundary falling between them silently drops
  // one row and repeats the other. Neither the oracle nor the count would notice;
  // this does.
  //
  // Run against a narrow facet set AND the unfiltered board, because the narrow one
  // fits in a page or two and would never exercise a boundary at all.
  console.log("\n\x1b[1mpaging (windows of the same body must tile it)\x1b[0m");
  for (const [label, f] of [
    ["narrow facets", hi],
    ["unfiltered board", full],
  ] as const) {
    const ref = await board(f); // the unwindowed body — the reference
    if (!ref) {
      ok(`${label}: reference read`, false, lastError);
      continue;
    }
    const refIds = ref.rows.map((r) => r.id);
    const total = refIds.length;
    // Four-ish tiles rather than `total / PAGE_SIZE` pages: the property is about
    // boundaries, not about page count, and a full walk of the unfiltered board at
    // 10,000 rows would be two hundred reads of a query that takes minutes.
    const size = Math.max(PAGE_SIZE, Math.ceil(total / 4));
    const pages: BoardRow[][] = [];
    let refused = false;
    for (let offset = 0; offset < total; offset += size) {
      const rows = await windowRows(f, { limit: size, offset });
      if (!rows) {
        refused = true;
        break;
      }
      pages.push(rows);
    }
    if (refused) {
      ok(`${label}: every page reads`, false, lastError);
      continue;
    }

    const flat = pages.flatMap((p) => p.map((r) => r.id));
    ok(
      `${label}: concat(pages) == the unpaginated result, IN ORDER`,
      same(flat, refIds),
      `${pages.length} pages of ${size} · ${flat.length.toLocaleString()} vs ${total.toLocaleString()}`,
    );
    // Stated separately from the concatenation because they fail differently and a
    // one-line diagnosis is worth two extra assertions: an overlap means a boundary
    // repeated a row, a drop means it skipped one.
    const seen = new Set<number>();
    let overlap = 0;
    for (const id of flat) {
      if (seen.has(id)) overlap++;
      seen.add(id);
    }
    ok(`${label}: pages do not overlap`, overlap === 0, `${overlap} repeated row(s)`);
    ok(
      `${label}: pages drop nothing`,
      seen.size === total,
      `${seen.size.toLocaleString()} distinct of ${total.toLocaleString()}`,
    );

    // Past the end is EMPTY, not an error and not a wrapped page. The pager offers
    // "next" from a read-ahead row, so it should never ask — but a stale click can,
    // and the answer has to be a blank board rather than a 500.
    const past = await windowRows(f, { limit: size, offset: total + size });
    ok(
      `${label}: paging past the end returns empty`,
      !!past && past.length === 0,
      past ? `${past.length} rows` : lastError,
    );

    // And the window the APP actually uses: PAGE_SIZE + 1, offset page*PAGE_SIZE.
    for (const page of [0, 1]) {
      if (page * PAGE_SIZE >= total) continue;
      const rows = await windowRows(f, pageWindow(page));
      const want = refIds.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE + 1);
      ok(
        `${label}: the app's own window for page ${page + 1}`,
        !!rows &&
          same(
            rows.map((r) => r.id),
            want,
          ),
        rows ? `${rows.length} rows (${PAGE_SIZE} shown + read-ahead)` : lastError,
      );
    }
  }

  // ---- 8. the shape this change replaced ---------------------------------
  //
  // The facet filters used to be VALUE-JOINS: four clauses each, matching the
  // session's `sf` children against every candidate row. They are inlined literal
  // comparisons now. That is a rewrite of the query, so the property that matters
  // is that it did not change the ANSWER — asked of the engine, on the real corpus,
  // rather than of the oracle, which both bodies are checked against separately.
  //
  // The joined body is reconstructed from the app's own body by swapping the two
  // inlined clauses back out, so it cannot drift into testing something else: if
  // `canonicalBody` stops producing the clauses this expects, `replaced` is not 2
  // and the assertion fails rather than quietly comparing a body to itself.
  console.log("\n\x1b[1minlined facets vs the value-join they replaced\x1b[0m");
  for (const [label, f] of [
    ["priority=high status=todo", hi],
    ["priority=high,low status=todo", both],
    ["every facet selected", full],
  ] as const) {
    const sid = await sessionFor(f);
    const joined = joinedBody(f, sid, null);
    const inline = await runBoard(canonicalBody(queryOf(f), null));
    const join = await runBoard(joined.body);
    if (!inline || !join) {
      ok(`${label}: both bodies read`, false, lastError);
      continue;
    }
    // Compared by entity id, not by corpus index: section 6 writes two todos whose
    // titles are not `stress NNNNNNN`, so `kOf` gives them NaN and NaN never equals
    // itself. An id is what the rows actually are.
    ok(
      `${label}: inlined == joined, row for row`,
      joined.replaced === joined.expected &&
        same(
          inline.rows.map((r) => r.id),
          join.rows.map((r) => r.id),
        ),
      `${joined.replaced}/${joined.expected} clauses swapped · ${inline.rows.length.toLocaleString()} vs ` +
        `${join.rows.length.toLocaleString()} rows · inlined ${inline.ms}ms, joined ${join.ms}ms`,
    );
    // The same two bodies at the size the APP asks for — one page. Reported
    // separately because the assertion above compares whole result sets and this is
    // the read a browser actually waits on, and the row count travels with the
    // timing: a body that matched nothing would be the fastest line here.
    const pageInline = await runBoard(canonicalBody(queryOf(f), pageWindow(0)));
    const pageJoin = await runBoard(joinedBody(f, sid, pageWindow(0)).body);
    console.log(
      `        one page (${PAGE_SIZE} + read-ahead): inlined ${String(pageInline?.ms ?? -1).padStart(5)}ms, ` +
        `joined ${String(pageJoin?.ms ?? -1).padStart(5)}ms   ` +
        `${(pageInline?.rows.length ?? 0).toLocaleString()} rows either way`,
    );
  }

  // ---- 9. performance ----------------------------------------------------
  console.log("\n\x1b[1mperformance\x1b[0m");
  const size = (r: { bytes: number }, unit: number, suffix: string) =>
    r.bytes < 0
      ? `\x1b[33mnot returned\x1b[0m — ${lastError}`
      : `${(r.bytes / unit).toFixed(unit === 1024 ? 0 : 1)}${suffix}`;
  const wide = await raw(full);
  console.log(
    `  unfiltered board   ${String(wide.ms).padStart(6)}ms   ${size(wide, 1048576, "MB")}   ` +
      `expected ${expectedCount(N, full, NOW).toLocaleString()} rows`,
  );
  const narrowPerf = await raw(hi);
  console.log(`  narrow slice       ${String(narrowPerf.ms).padStart(6)}ms   ${size(narrowPerf, 1024, "KB")}`);

  // The tag body used to be the one that still ran a correlated `exists`, and so the
  // one with a ceiling of its own — one label cost 104,475ms at ten thousand todos
  // and three labels were REFUSED (`where subquery row/output limit exceeded (per
  // directive max 1000)`). It is a membership test over the todo's own `tags` list
  // now: 84ms, and flat in the number of labels, because more labels is a bigger set
  // literal rather than more subquery executions. The row counts travel with the
  // timings on purpose — a filter matching nothing is the fastest line here.
  for (const [label, f] of [
    ["tag + narrow facets", { ...full, priority: ["high"], tagActive: true, tags: ["alpha"] } as Facets],
    ["tag + every facet", { ...full, tagActive: true, tags: ["alpha"] } as Facets],
    ["two labels", { ...full, tagActive: true, tags: ["alpha", "beta"] } as Facets],
    ["a label nothing carries", { ...full, tagActive: true, tags: ["gamma"] } as Facets],
  ] as const) {
    const got = await board(f);
    console.log(
      got
        ? `  ${label.padEnd(18)} ${String(got.ms).padStart(6)}ms   ${got.rows.length.toLocaleString()} rows`
        : `  ${label.padEnd(18)} \x1b[33mrefused\x1b[0m — ${lastError}`,
    );
  }

  // What a window COSTS, which is the number that decided the shape of the phase.
  // The hypothesis going in was that `limit` would finally terminate early now that
  // the body runs zero subqueries. It does not: these three lines come back within
  // noise of each other, and so does a bare count over the identical `where`. So
  // `limit` is a post-filter, paging bounds the response and not the query, and a
  // count for the pill would double the work of every page view. That last number
  // is why the count pill says "50+".
  for (const [label, w] of [
    ["unlimited", null],
    [`limit ${PAGE_SIZE}`, { limit: PAGE_SIZE, offset: 0 }],
    [`limit ${PAGE_SIZE} offset 5000`, { limit: PAGE_SIZE, offset: 5000 }],
  ] as [string, PageWindow | null][]) {
    const t0 = Date.now();
    const rows = w ? await windowRows(full, w) : (await board(full))?.rows;
    console.log(
      `  ${label.padEnd(22)} ${String(Date.now() - t0).padStart(6)}ms   ${(rows?.length ?? 0).toLocaleString()} rows`,
    );
  }
  // The count a "showing 50 of N" pill would need: the board's OWN `where`, with
  // the projection replaced by a tally. It has to be that query — a count over the
  // todo facts alone omits the session join, the facet filters and the visibility
  // `or`, and comes back in milliseconds, which would be a comforting and
  // completely wrong number.
  //
  // It is also the one place a ROW COUNT is asserted against a timing, which is a
  // rule this file learned expensively: a read that matches nothing is fast, and a
  // fast number with no count beside it is not evidence of anything.
  const tally = await countLikeTheBoard(full);
  console.log(
    `  ${"count over the same".padEnd(22)} ${String(tally.ms).padStart(6)}ms   ${tally.n.toLocaleString()} matching`,
  );
  // `+ CLOCK_TODOS` because section 6 wrote two of them into the corpus's own
  // workspace, and both are visible under the unfiltered facets. The oracle is a
  // function of N and does not know about them — which is the sort of thing an
  // assertion over a perturbed corpus has to say out loud rather than absorb.
  const wantWide = expectedCount(N, full, NOW) + CLOCK_TODOS;
  ok(
    "the timed board matches the number of rows the spec expects",
    tally.n === wantWide,
    `${tally.n.toLocaleString()} vs ${wantWide.toLocaleString()}`,
  );

  // What a DEEP page costs, and what it used to cost. Page 0 was a provisioned
  // reactor read with a bind; every other page was a reactor created for the read
  // and deleted after it (31-44ms + 21-38ms on this box, plus ~158 entity ids that
  // never come back). A dry-run body carries its own window, so a deep page is now
  // the same read as page 1 — and the two lines below are the same query, once the
  // way the app does it and once the way it used to.
  console.log("\n\x1b[1mdeep paging: a dry-run vs the ephemeral reactor it replaced\x1b[0m");
  for (const page of [0, 20, 60]) {
    const t0 = Date.now();
    const rows = await windowRows(full, pageWindow(page));
    const dryMs = Date.now() - t0;
    const via = await windowViaReactor(full, pageWindow(page));
    console.log(
      `  page ${String(page + 1).padEnd(4)} dry-run ${String(dryMs).padStart(6)}ms (${(rows?.length ?? 0).toLocaleString()} rows)` +
        `   ephemeral reactor ${String(via.ms).padStart(6)}ms (${via.n.toLocaleString()} rows` +
        `, ${via.createMs}ms create + ${via.deleteMs}ms delete)`,
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

/**
 * Do a todo's `tags` COMPONENT and its tag EDGES still say the same thing?
 *
 * The tag half of `derivedHolds`, and deliberately asked twice: `reconcileTags` is
 * the guard that ships and gets to answer for the whole workspace, and then the
 * component is read back per touched todo and compared against the edges directly,
 * so a guard and a write path that are wrong in the same way cannot agree their way
 * past this.
 */
async function tagsHold(ctx: WorkspaceCtx, ws: number, live: number[]): Promise<[boolean, string]> {
  const problems: string[] = [];
  // The component is read with a bare `find` TUPLE, which is the only shape that
  // hands back the list itself. `then.project` and `GET /entities/{id}` both give a
  // REF to the list entity instead (`{"#": 92}`) — an array component is stored as
  // one, and only find-tuple output resolves it. Reading it the other way is how
  // this check first "passed" against a value that was never an array.
  const stored = new Map<number, string[]>(
    (
      await dry<[number, string[]]>({
        find: ["?t", "?tags"],
        where: [
          ["?t", "app", "todo-app"],
          ["?t", "workspace", { "#": ws }],
          ["?t", "tags", "?tags"],
        ],
      })
    ).map(([id, tags]) => [id, tags ?? []]),
  );
  for (const id of live) {
    const have = (stored.get(id) ?? []).slice().sort();
    const edges = (await tagsOf(ctx, id)).slice().sort();
    if (have.join(" ") !== edges.join(" ")) {
      problems.push(`#${id} component [${have.join(" ")}] but edges [${edges.join(" ")}]`);
    }
  }
  const shipped = await reconcileTags(ws);
  if (shipped.length) {
    problems.push(
      `reconcileTags reported ${shipped.length}: ` +
        shipped
          .slice(0, 2)
          .map((d) => `#${d.id} [${(d.stored ?? []).join(" ")}] != [${d.actual.join(" ")}]`)
          .join(", "),
    );
  }
  return [problems.length === 0, problems.slice(0, 3).join(" · ")];
}

// ---------------------------------------------------------------------------
// The board read, done the app's way: one DRY-RUN of `canonicalBody`, with this
// configuration's selected facet values compiled into it as literals. There is no
// stored reactor to pick, for the reference read or for a page — a body that
// inlines the selection is a function of the filter, so there is nothing a bind
// could parameterise and nothing to provision ahead of time.
// ---------------------------------------------------------------------------

/**
 * The scope every board in this run is read in, set once the corpus exists.
 *
 * It is a module variable because the alternative is threading two entity ids
 * through every helper below, and because it is genuinely constant for a run: the
 * corpus has one workspace and two personas. `viewerIsOwner` is the only thing a
 * configuration chooses.
 */
let SCOPE: { owner: BoardScope; member: BoardScope };

/** The app's BoardQuery for a harness configuration. `now` is the harness's fixed
 *  clock, so the overdue body is the same on every read of a run. */
const queryOf = (f: Facets): BoardQuery => ({
  ...(f.viewerIsOwner ? SCOPE.owner : SCOPE.member),
  status: f.status,
  priority: f.priority,
  tags: f.tagActive ? f.tags : [],
  view: f.view,
  now: new Date(NOW),
});

/**
 * Run a board body and parse the rows. `null` when the engine refused it.
 *
 * The refusal is reported WITH the body that provoked it. That is not decoration:
 * a `ron: invalid #utc payload at byte 0` at 10,000 rows cost most of a day,
 * because the message describes what the engine thinks it RECEIVED and the harness
 * only printed the message — so every hypothesis about what had been SENT was
 * unfalsifiable.
 */
async function runBoard(body: unknown): Promise<{ rows: BoardRow[]; ms: number } | null> {
  const t0 = Date.now();
  let parsed: any;
  try {
    const res = await fetch(`${BASE}/reactors/dry-run`, { method: "POST", headers: H, body: JSON.stringify(body) });
    parsed = JSON.parse((await res.text()).trim().split("\n")[0] ?? "[]");
  } catch (e) {
    parsed = { "stardust/error": true, message: describe(e) };
  }
  if (parsed && parsed["stardust/error"]) {
    lastError = `${parsed.message}\n        body ${JSON.stringify(body).slice(0, 400)}`;
    console.log(`\x1b[31m  refused after ${Date.now() - t0}ms\x1b[0m ${lastError}`);
    return null;
  }
  return { rows: parsed as BoardRow[], ms: Date.now() - t0 };
}

/**
 * The board body with the INLINED facet filters swapped back out for the
 * value-joins they replaced — the shape that shipped before this change.
 *
 * Built by surgery on the app's own body rather than written out again, so it
 * cannot drift into testing a query nobody ever ran. `replaced` is how the caller
 * knows the surgery found what it was looking for, and `expected` is how many
 * clauses there were to find: comparing the two is what keeps this from quietly
 * becoming a body against itself.
 *
 * `expected` is not always 2 any more, and that is the point of the pair.
 * `canonicalBody` emits NOTHING for a selection covering the whole domain — a
 * clause that cannot remove a row is not written at all — so a board with every
 * facet ticked has nothing to swap. The value-join is still added in that case,
 * because the join is the shape being compared and the old body carried it
 * whatever was selected. `facetClauses` is imported from the app rather than
 * reimplemented, so this cannot disagree with it about what was emitted.
 *
 * What it swaps is a GROUP of clauses, not a clause: a single selected value is one
 * fact clause and several are a fact clause plus a membership test, and the app
 * hands both over as a `Narrowing` so this does not have to guess which loose
 * clauses belonged together. The joins go on the END, where the shipped body
 * carried them — the app's own narrowing clauses LEAD the body now, and putting a
 * four-clause value-join in that position would be comparing against a shape
 * nobody ever ran.
 */
function joinedBody(
  f: Facets,
  sid: number,
  window: PageWindow | null,
): { body: unknown; replaced: number; expected: number } {
  const joins: Record<string, unknown[]> = {
    "?priority": [
      ["?fp", "kind", "sf"],
      ["?fp", "session", "?sess"],
      ["?fp", "facet", "priority"],
      ["?fp", "value", "?priority"],
    ],
    "?eff": [
      ["?fs", "kind", "sf"],
      ["?fs", "session", "?sess"],
      ["?fs", "facet", "status"],
      ["?fs", "value", "?eff"],
    ],
  };
  // exactly what the app put in the body, group by group
  const emitted = facetClauses(queryOf(f));
  const leads = new Set(emitted.map((g) => JSON.stringify(g.clauses[0])));
  const rest = new Set(emitted.flatMap((g) => g.clauses.slice(1).map((c) => JSON.stringify(c))));

  const body = canonicalBody(queryOf(f), window) as { where: unknown[] };
  // The session the join needs. `canonicalBody` no longer selects one — the filter
  // is a parameter, not a fact — so the shape being reconstructed has to bring its
  // own anchor, exactly as the shipped body used to carry it.
  const where: unknown[] = [
    ["?sess", "kind", "session"],
    ["?sess", "sid", sid],
  ];
  let replaced = 0;
  for (const clause of body.where) {
    const k = JSON.stringify(clause);
    if (leads.has(k))
      replaced++; // the group's first clause — the one being swapped
    else if (!rest.has(k)) where.push(clause); // …and the rest of that same group
  }
  // Both joins, always, and at the END: a facet the app no longer narrows still
  // gets one, so the comparison keeps its teeth on a fully-selected board.
  for (const join of Object.values(joins)) where.push(...join);
  return { body: { ...body, where }, replaced, expected: emitted.length };
}

async function raw(f: Facets): Promise<{ ms: number; bytes: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/reactors/dry-run`, {
      method: "POST",
      headers: H,
      body: JSON.stringify(canonicalBody(queryOf(f), null)),
    });
    let bytes = 0;
    for await (const chunk of res.body!) bytes += (chunk as Uint8Array).length;
    return { ms: Date.now() - t0, bytes };
  } catch (e) {
    lastError = describe(e);
    return { ms: Date.now() - t0, bytes: -1 };
  }
}

/**
 * A fetch that did not come back, in one line.
 *
 * Node's fetch gives up on a response BODY after five minutes and throws
 * `TypeError: terminated` with a `BodyTimeoutError` cause — which reads like the
 * server died and does not mean that. The tag body at 10,000 todos crosses that
 * line, and an unhandled throw there cost a completed two-hour run its summary, so
 * every board read here reports a refusal instead of ending the process.
 */
function describe(e: unknown): string {
  const err = e as { message?: string; cause?: { name?: string; message?: string } };
  const cause = err?.cause?.name ?? err?.cause?.message;
  return `${err?.message ?? String(e)}${cause ? ` (${cause})` : ""}`;
}

/** One WINDOW of the same body — the app's paged read, done the app's way. A
 *  window is `limit`/`offset` in the body, so a page is the same dry-run with two
 *  more numbers in it; it used to be a reactor created for the read and deleted
 *  after it, which is what `windowViaReactor` still measures. */
async function windowRows(f: Facets, w: PageWindow): Promise<BoardRow[] | null> {
  return (await runBoard(canonicalBody(queryOf(f), w)))?.rows ?? null;
}

/**
 * The SAME page, read the way it used to be: a reactor created for this read and
 * deleted after it. Kept only to keep the cost of what was removed measurable next
 * to what replaced it — the app has no path that does this any more.
 *
 * `enabled: false` because a reactor made for one bound read should not also be
 * asked to evaluate itself unbound.
 */
async function windowViaReactor(
  f: Facets,
  w: PageWindow,
): Promise<{ ms: number; n: number; createMs: number; deleteMs: number }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/reactors`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ ...canonicalBody(queryOf(f), w), enabled: false }),
  });
  const createMs = Date.now() - t0;
  const rec = JSON.parse((await res.text()).trim().split("\n")[0]!);
  if (rec["stardust/error"]) {
    lastError = `${rec.message} · window limit ${w.limit} offset ${w.offset}`;
    return { ms: Date.now() - t0, n: -1, createMs, deleteMs: 0 };
  }
  const rid = typeof rec.reactorId === "object" ? rec.reactorId["#"] : rec.reactorId;
  let n = -1;
  try {
    const r = await fetch(`${BASE}/reactors/${rid}/results?max=1`, { headers: { Accept: "application/x-ndjson" } });
    const rows = JSON.parse((await r.text()).trim().split("\n")[0] ?? "[]");
    if (Array.isArray(rows)) n = rows.length;
  } catch (e) {
    lastError = describe(e);
  }
  const t1 = Date.now();
  // A reactor is durable state. A harness that leaves one behind per page read is a
  // harness that changes the database it is measuring.
  await fetch(`${BASE}/reactors/${rid}`, { method: "DELETE", headers: { Accept: "application/x-ndjson" } });
  return { ms: Date.now() - t0, n, createMs, deleteMs: Date.now() - t1 };
}

/** What a total for the count pill would cost: the board's body, counting instead
 *  of projecting. The COUNT comes back with the timing, because a timing on its
 *  own cannot tell a fast query from an empty one. */
async function countLikeTheBoard(f: Facets): Promise<{ ms: number; n: number }> {
  const { orderBy: _o, then: _t, ...rest } = canonicalBody(queryOf(f), null) as Record<string, unknown>;
  const t0 = Date.now();
  const res = await fetch(`${BASE}/reactors/dry-run`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ ...rest, find: [["count", "?t"]] }),
  });
  const rows = JSON.parse((await res.text()).trim().split("\n")[0] ?? "[]");
  if (rows && rows["stardust/error"]) {
    lastError = String(rows.message);
    return { ms: Date.now() - t0, n: -1 };
  }
  return { ms: Date.now() - t0, n: Number(rows?.[0]?.[0] ?? 0) };
}

/** The unwindowed board for a configuration — the oracle's reference read.
 *  null when the engine refused the query: recorded as a failure, not a crash. */
async function board(f: Facets): Promise<{ rows: BoardRow[]; ms: number } | null> {
  return runBoard(canonicalBody(queryOf(f), null));
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
