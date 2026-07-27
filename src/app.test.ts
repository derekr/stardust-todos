// Unit tests for the pure logic — no live Stardust needed. Run: `npm test`
// (node:test runs .ts natively via Node's type stripping; the integration
// coverage lives in the demo:* scripts, which exercise a real Stardust instance.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleTo } from "./derive.ts";
import { effectiveStatus } from "./board.ts";
import { type BoardQuery, PAGE_SIZE, boardQuery, canonicalBody, pageWindow } from "./session.ts";
import { validators } from "./field-registry.ts";
import { validationPlan } from "./typed-query.ts";

test("visibleTo builds the published-OR-mine predicate (bound scalars + expression or)", () => {
  assert.deepEqual(visibleTo(154), [
    ["?t", "draft", "?draft"],
    ["?t", "author", "?author"],
    ["or", ["=", "?draft", false], ["=", "?author", { "#": 154 }]],
  ]);
});

test("effectiveStatus prefers the STORED fact, and computes it otherwise", () => {
  // what every reactor projects now — the row already carries the answer
  assert.equal(effectiveStatus({ status: "todo", blocked: true, effectiveStatus: "blocked" }), "blocked");
  assert.equal(effectiveStatus({ status: "doing", blocked: false, effectiveStatus: "doing" }), "doing");
  // the fallback, for a row the caller assembled itself (the detail page)
  assert.equal(effectiveStatus({ status: "todo", blocked: true }), "blocked");
  assert.equal(effectiveStatus({ status: "todo", blocked: false }), "todo");
  assert.equal(effectiveStatus({ status: "done", blocked: true }), "done"); // done wins
  assert.equal(effectiveStatus({ status: "todo" }), "todo"); // undefined blocked
});

/** A session with nothing narrowed: the shape every browser opens on. */
const PLAIN: BoardQuery = {
  sid: 574,
  status: [],
  priority: [],
  view: "all",
  tag: false,
  now: new Date("2026-07-26T00:00:00Z"),
};
const whereOf = (q: BoardQuery) => (canonicalBody(q, null) as { where: unknown[] }).where;
const clauses = (q: BoardQuery) => JSON.stringify(whereOf(q));

test("the plain board body executes NO subqueries and joins the stored fields", () => {
  const body = canonicalBody(PLAIN, null) as { where: unknown[]; orderBy: string[] };
  const json = JSON.stringify(body.where);
  assert.equal(json.includes("exists"), false); // the whole point of phase 2
  assert.equal(json.includes("cond"), false);
  for (const field of ["blocked", "effectiveStatus", "prank"]) {
    assert.ok(
      body.where.some((c) => Array.isArray(c) && c[0] === "?t" && c[1] === field),
      `joins ${field}`,
    );
  }
  // ascending prank is high→med→low; ?t breaks ties that ?title does not
  assert.deepEqual(body.orderBy, ["?prank", "?title", "?t"]);
});

test("the facet filters are INLINED literals, not value-joins", () => {
  const q: BoardQuery = { ...PLAIN, status: ["todo", "doing"], priority: ["high"] };
  const where = whereOf(q);
  // one selected value is a bare `=`; several are an `or` over `=`
  assert.ok(where.some((c) => JSON.stringify(c) === '["=","?priority","high"]'));
  assert.ok(where.some((c) => JSON.stringify(c) === '["or",["=","?eff","todo"],["=","?eff","doing"]]'));
  // and NOTHING joins the session's `sf` children for those two facets any more
  assert.equal(clauses(q).includes('"facet","priority"'), false);
  assert.equal(clauses(q).includes('"facet","status"'), false);
});

test("an empty selection means the whole domain, materialized", () => {
  // The facets are WRITTEN as the full domain when nothing is picked, and read back
  // as []. Both have to compile to the same body, or "select everything" and
  // "select nothing" would disagree.
  assert.equal(clauses(PLAIN), clauses({ ...PLAIN, status: ["todo", "doing", "blocked", "done"] }));
  assert.ok(clauses(PLAIN).includes('["or",["=","?eff","todo"],["=","?eff","doing"]'));
  assert.ok(clauses(PLAIN).includes('["or",["=","?priority","low"],["=","?priority","med"]'));
});

test("a value outside its domain is REFUSED, which is what makes inlining safe", () => {
  // The guard that lets a selected value become part of the query. Statuses,
  // priorities and views have fixed domains; tag labels do not, which is exactly
  // why the tag filter stays a correlated `exists` and is not inlined at all.
  assert.throws(() => canonicalBody({ ...PLAIN, status: ["archived"] }, null), /not one of/);
  assert.throws(() => canonicalBody({ ...PLAIN, priority: ["urgent"] }, null), /not one of/);
  assert.throws(() => canonicalBody({ ...PLAIN, view: "everything" }, null), /not one of/);
});

test("the body has no free vars, so no forgotten bind can widen it", () => {
  // A dry-run has no bind. Both inputs that used to be one — the session's `sid`
  // and the overdue wall clock — are literals in the body now, and an absent bind
  // on a FACT clause is the failure that returns a superset rather than an error.
  const json = JSON.stringify(canonicalBody({ ...PLAIN, view: "overdue", tag: true }, pageWindow(0)));
  assert.equal(json.includes("?sid"), false);
  assert.equal(json.includes("?now"), false);
  assert.ok(json.includes('["?sess","sid",574]'));
});

test("the optional clause groups appear exactly when they are called for", () => {
  assert.equal(clauses({ ...PLAIN, tag: true }).includes("exists"), true);
  assert.equal(clauses({ ...PLAIN, view: "overdue" }).includes("exists"), false); // plain clauses
  assert.equal(
    clauses({ ...PLAIN, view: "overdue" }).includes('["<","?due",{"#utc":"2026-07-26T00:00:00.000Z"}]'),
    true,
  );
  assert.equal(clauses(PLAIN).includes("?due"), false);
});

test("boardQuery carries the session's filter, and only whether a tag is picked", () => {
  const now = new Date("2026-07-26T00:00:00Z");
  assert.deepEqual(
    boardQuery(574, { status: ["done"], priority: [], tags: ["alpha"], view: "mine", group: "none" }, now),
    {
      sid: 574,
      status: ["done"],
      priority: [],
      view: "mine",
      // the LABELS never cross: they are free text, so they stay in the subquery
      tag: true,
      now,
    },
  );
});

test("a page window is limit/offset on the body, and asks for one row too many", () => {
  // The 51st row is what tells the pager there is a next page. A query that
  // returned exactly PAGE_SIZE could not distinguish "a full page" from "the end",
  // and the alternative — counting — costs a second full evaluation of the board.
  assert.deepEqual(pageWindow(0), { limit: PAGE_SIZE + 1, offset: 0 });
  assert.deepEqual(pageWindow(3), { limit: PAGE_SIZE + 1, offset: 3 * PAGE_SIZE });

  const windowed = canonicalBody(PLAIN, pageWindow(2)) as Record<string, unknown>;
  assert.equal(windowed.limit, PAGE_SIZE + 1);
  assert.equal(windowed.offset, 2 * PAGE_SIZE);
  // and no window means no window — the oracle in scripts/stress reads this body
  const unpaged = canonicalBody(PLAIN, null) as Record<string, unknown>;
  assert.equal("limit" in unpaged, false);
  assert.equal("offset" in unpaged, false);
  // offset paging is only meaningful over a TOTAL order; ?t is the tiebreaker
  assert.deepEqual((windowed as { orderBy: string[] }).orderBy, ["?prank", "?title", "?t"]);
});

test("schema-generated validators accept valid values and reject drift", () => {
  assert.equal(validators.status("done"), true);
  assert.equal(validators.status("archived"), false); // not in the Todo enum
  assert.equal(validators.priority("high"), true);
  assert.equal(validators.priority("urgent"), false);
  assert.equal(validators.role("owner"), true);
  assert.equal(validators.role("admin"), false);
  assert.equal(validators.draft(true), true);
  assert.equal(validators.draft("yes"), false);
  assert.equal(validators.author({ "#": 1 }), true); // ref
  assert.equal(validators.author(1), false);
});

test("validationPlan maps projected keys to their field validators", () => {
  const plan = validationPlan(
    [
      ["?t", "app", "todo-app"],
      ["?t", "status", "?s"],
    ],
    { id: "?t", status: "?s" },
  );
  const byKey = Object.fromEntries(plan.map((p) => [p.key, p.field]));
  assert.equal(byKey.id, "@id"); // subject var → entity id
  assert.equal(byKey.status, "status"); // object var → its field
  const statusCheck = plan.find((p) => p.key === "status")!;
  assert.equal(statusCheck.check("done"), true);
  assert.equal(statusCheck.check("archived"), false); // the boundary catches drift
});
