// Unit tests for the pure logic — no live Stardust needed. Run: `npm test`
// (node:test runs .ts natively via Node's type stripping; the integration
// coverage lives in the demo:* scripts, which exercise a real Stardust instance.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleTo } from "./derive.ts";
import { SEARCH_LIMIT, effectiveStatus, todoSearchBody } from "./board.ts";
import { type BoardQuery, PAGE_SIZE, boardQuery, canonicalBody, pageWindow } from "./board-query.ts";
import {
  type BoardState,
  FilterError,
  boardHref,
  decodeFilter,
  emptyFilter,
  emptyState,
  encodeFilter,
  toggled,
} from "./filter.ts";
import { validators } from "./field-registry.ts";
import { TAG_LABEL_MAX, TagLabelError, canonicalTags, tagClauses, tagLabel } from "./tags.ts";
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

/** A board with nothing narrowed: the shape every reader opens on. */
const SCOPE = { workspace: 12, viewer: 7, actor: "Owner" };
const PLAIN: BoardQuery = {
  ...SCOPE,
  status: [],
  priority: [],
  tags: [],
  view: "all",
  now: new Date("2026-07-26T00:00:00Z"),
};
const whereOf = (q: BoardQuery) => (canonicalBody(q, null) as { where: unknown[] }).where;
const clauses = (q: BoardQuery) => JSON.stringify(whereOf(q));

test("the board body executes NO subqueries — with a tag filter or without one", () => {
  const body = canonicalBody(PLAIN, null) as { where: unknown[]; orderBy: string[] };
  const json = JSON.stringify(body.where);
  assert.equal(json.includes("exists"), false); // the whole point of phase 2
  assert.equal(json.includes("cond"), false);
  // The tag clause was the last one left, and it was the one that hard-failed: a
  // subquery's OUTPUT is capped at 1,000 rows per directive, so three labels was a
  // refusal the app rendered as an empty board.
  assert.equal(clauses({ ...PLAIN, tags: ["alpha", "beta"] }).includes("exists"), false);
  for (const field of ["blocked", "effectiveStatus", "prank"]) {
    assert.ok(
      body.where.some((c) => Array.isArray(c) && c[0] === "?t" && c[1] === field),
      `joins ${field}`,
    );
  }
  // ascending prank is high→med→low; ?t breaks ties that ?title does not
  assert.deepEqual(body.orderBy, ["?prank", "?title"]);
});

test("the facet filters are INLINED literals, not value-joins", () => {
  const q: BoardQuery = { ...PLAIN, status: ["todo", "doing"], priority: ["high"] };
  const where = whereOf(q);
  // one selected value is a bare `=`; several are an `or` over `=`
  assert.ok(where.some((c) => JSON.stringify(c) === '["=","?priority","high"]'));
  assert.ok(where.some((c) => JSON.stringify(c) === '["or",["=","?eff","todo"],["=","?eff","doing"]]'));
  // and NOTHING joins a session's `sf` children — there is no session left to join
  assert.equal(clauses(q).includes('"facet"'), false);
  assert.equal(clauses(q).includes('"sf"'), false);
});

test("a selection covering the whole domain emits NO clause", () => {
  // "select everything" and "select nothing" have to compile to the same body: the
  // UI treats them as the same thing, and the URL omits a full selection entirely.
  // That body used to spell them both out as an `or` over every branch — which
  // cannot remove a row, because the fact clause above it can only bind a value
  // that is one of them. Seven redundant comparisons per row of the workspace, and
  // 85ms against 54ms for one unfiltered page at 10,003 todos.
  assert.equal(clauses(PLAIN), clauses({ ...PLAIN, status: ["todo", "doing", "blocked", "done"] }));
  assert.equal(clauses(PLAIN), clauses({ ...PLAIN, priority: ["low", "med", "high"] }));
  assert.equal(clauses(PLAIN).includes('["=","?eff"'), false); // no comparison at all
  assert.equal(clauses(PLAIN).includes('["=","?priority"'), false);
  assert.ok(clauses(PLAIN).includes('["?t","priority","?priority"]')); // the fact clause stays
  assert.ok(clauses(PLAIN).includes('["?t","effectiveStatus","?eff"]'));
  // and a PARTIAL selection is still inlined, on either facet independently
  assert.ok(clauses({ ...PLAIN, status: ["todo"] }).includes('["=","?eff","todo"]'));
  assert.equal(clauses({ ...PLAIN, status: ["todo"] }).includes('"?priority","low"'), false);
});

test("a value outside its domain is REFUSED, which is what makes inlining safe", () => {
  // The guard that lets a selected value become part of the query. `decodeFilter`
  // already refused it on the way in from the URL; this is the second check over
  // the same boundary, and it is the one every non-HTTP caller goes through.
  assert.throws(() => canonicalBody({ ...PLAIN, status: ["archived"] }, null), /not one of/);
  assert.throws(() => canonicalBody({ ...PLAIN, priority: ["urgent"] }, null), /not one of/);
  assert.throws(() => canonicalBody({ ...PLAIN, view: "everything" }, null), /not one of/);
});

test("the body has no free vars, so no forgotten bind can widen it", () => {
  // A dry-run has no bind, and every input that used to be one is a literal:
  // workspace, viewer, actor and the overdue wall clock. An absent bind on a FACT
  // clause is the failure that returns a superset rather than an error.
  const json = JSON.stringify(canonicalBody({ ...PLAIN, view: "overdue", tags: ["alpha"] }, pageWindow(0)));
  assert.equal(json.includes("?sid"), false);
  assert.equal(json.includes("?sess"), false);
  assert.equal(json.includes("?now"), false);
  assert.equal(json.includes("?viewer"), false);
  assert.equal(json.includes("?ws"), false);
  assert.ok(json.includes('["?t","workspace",{"#":12}]'));
  assert.ok(json.includes('["=","?author",{"#":7}]'));
});

test("the optional clause groups appear exactly when they are called for", () => {
  // Only the branch that applies is emitted at all: `view` is a compile-time value
  // now, where it used to be a var joined off the session and tested by an `or`
  // over four branches.
  assert.ok(clauses({ ...PLAIN, tags: ["alpha"] }).includes('["?t","tags","?tags"]'));
  assert.ok(clauses({ ...PLAIN, tags: ["alpha"] }).includes('{"#set":["alpha"]}'));
  assert.equal(clauses({ ...PLAIN, view: "overdue" }).includes("exists"), false); // plain clauses
  assert.ok(clauses({ ...PLAIN, view: "overdue" }).includes('["<","?due",{"#utc":"2026-07-26T00:00:00.000Z"}]'));
  assert.equal(clauses(PLAIN).includes("?due"), false);
  assert.ok(clauses({ ...PLAIN, view: "ready" }).includes('["=","?eff","todo"]'));
  assert.ok(clauses({ ...PLAIN, view: "mine" }).includes('["=","?lastActor","Owner"]'));
  assert.equal(clauses(PLAIN).includes('?lastActor","'), false); // `all` adds no view clause
});

test("the blocker picker's search is bounded, viewer-scoped, and takes the term as a VALUE", () => {
  const body = todoSearchBody(12, 7, 'o\'brien & "landing"');
  const json = JSON.stringify(body);

  // The term is one argument of one clause. It is never concatenated into query
  // text, so quotes, ampersands and apostrophes are data — this is the whole
  // reason the read is a dry-run with a JSON body rather than a stored reactor
  // read with a RON bind, where the same apostrophe ends the string early.
  assert.deepEqual((body.where as unknown[])[0], ["fts", 'o\'brien & "landing"', "?t", "?score"]);

  // Bounded in the QUERY. A picker that reads the whole corpus and slices it in
  // TypeScript is the bug this control already had once.
  assert.equal(body.limit, SEARCH_LIMIT);
  assert.deepEqual(body.orderBy, [["?score", "desc"], "?t"]);

  // Same visibility rule as every other read, with the viewer inlined: a draft you
  // cannot see must not become findable just because you searched for it.
  assert.ok(json.includes('["=","?author",{"#":7}]'));
  assert.ok(json.includes('["?t","workspace",{"#":12}]'));
  assert.equal(json.includes("?viewer"), false); // nothing left to forget to bind
});

test("the tag filter is a membership test over the row's OWN labels, not a subquery", () => {
  // Two clauses whatever the number of labels: bind the todo's list, then test it.
  // The list binds ONCE per row, which is what keeps a todo carrying two selected
  // labels from coming back twice — the duplicate that made this an `exists`.
  assert.deepEqual(tagClauses(["beta", "alpha"]), [
    ["?t", "tags", "?tags"],
    ["any", ["fn", ["l"], ["contains", { "#set": ["alpha", "beta"] }, "l"]], "?tags"],
  ]);
  // one label and five labels are the same two clauses — the ceiling that broke at
  // three labels was the subquery's, and there is no subquery left to have one
  const five = tagClauses(["e", "d", "c", "b", "a"]);
  assert.equal(five.length, 2);
  assert.deepEqual((five[1] as unknown[])[1], ["fn", ["l"], ["contains", { "#set": ["a", "b", "c", "d", "e"] }, "l"]]);
});

test("a tag label is checked in ONE place, on the way in and on the way out", () => {
  assert.equal(tagLabel("  design "), "design"); // trimmed
  assert.equal(tagLabel("o'brien & sons"), "o'brien & sons"); // a VALUE, not a field name
  assert.throws(() => tagLabel("   "), TagLabelError);
  assert.throws(() => tagLabel("x".repeat(TAG_LABEL_MAX + 1)), TagLabelError);
  // the comma is the one that is not hygiene: the filter URL joins labels with it,
  // so a label containing one could never survive its own share link
  assert.throws(() => tagLabel("design,launch"), TagLabelError);
  assert.throws(() => tagLabel("two\nlines"), TagLabelError);
  // canonical order + dedupe, so rewriting an unchanged set is `unchanged` at the
  // engine rather than a new fact
  assert.deepEqual(canonicalTags(["launch", "design", "launch"]), ["design", "launch"]);
  assert.throws(() => tagClauses(["ok", "bad,label"]), TagLabelError);
});

test("boardQuery carries the scope and the filter, tag labels included", () => {
  const now = new Date("2026-07-26T00:00:00Z");
  // The labels DO cross now. They used to stay behind in a subquery correlated to
  // the session's own `sf` rows; with no session, they are inlined like everything
  // else — which is why `decodeFilter` checks them against the workspace's own tag
  // vocabulary before they ever reach here.
  assert.deepEqual(
    boardQuery(SCOPE, { status: ["done"], priority: [], tags: ["alpha"], view: "mine", group: "none" }, now),
    { ...SCOPE, status: ["done"], priority: [], tags: ["alpha"], view: "mine", now },
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
  assert.deepEqual((windowed as { orderBy: string[] }).orderBy, ["?prank", "?title"]);
});

// ---- the filter codec ------------------------------------------------------
//
// These are the tests the search-session never had, and could not have: the filter
// used to arrive from a write the engine had validated against a schema, and it
// arrives from a URL now. So the codec IS the boundary, and every one of these is
// a check that used to be somebody else's job.

const VOCAB = ["alpha", "beta"];
const decode = (qs: string) => decodeFilter(new URLSearchParams(qs), VOCAB);

test("a bare board URL decodes to the empty filter, and encodes back to bare", () => {
  assert.deepEqual(decode(""), emptyState);
  assert.equal(encodeFilter(emptyState), "");
  assert.equal(boardHref(emptyState), "/");
});

test("the codec round-trips every state the app itself can produce", () => {
  const states: BoardState[] = [
    emptyState,
    { filter: { ...emptyFilter, status: ["todo", "done"] }, page: 0 },
    { filter: { ...emptyFilter, priority: ["high"], view: "ready" }, page: 3 },
    { filter: { ...emptyFilter, tags: ["alpha", "beta"], group: "none" }, page: 0 },
    {
      filter: { status: ["blocked"], priority: ["low", "med"], tags: ["beta"], view: "overdue", group: "priority" },
      page: 12,
    },
  ];
  for (const s of states) assert.deepEqual(decode(encodeFilter(s).slice(1)), s, encodeFilter(s));
});

test("an unknown value is REFUSED, not dropped — a dropped filter widens the board", () => {
  assert.throws(() => decode("st=archived"), FilterError);
  assert.throws(() => decode("pr=urgent"), FilterError);
  assert.throws(() => decode("v=everything"), FilterError);
  assert.throws(() => decode("g=sideways"), FilterError);
  assert.throws(() => decode("p=-1"), FilterError);
  assert.throws(() => decode("p=banana"), FilterError);
});

test("a tag is checked against the workspace's vocabulary, which is its only domain", () => {
  assert.deepEqual(decode("tag=alpha").filter.tags, ["alpha"]);
  // free text with no fixed domain — so the check is "is this a tag in use here"
  assert.throws(() => decode("tag=gamma"), FilterError);
  assert.throws(() => decode("tag=alpha,gamma"), FilterError);
});

test("toggling returns to page 1 when it changes WHAT matches, and not when it does not", () => {
  const at7: BoardState = { filter: { ...emptyFilter, status: ["todo"] }, page: 7 };
  assert.equal(toggled(at7, "status", "doing").page, 0);
  assert.deepEqual(toggled(at7, "status", "doing").filter.status, ["todo", "doing"]);
  assert.deepEqual(toggled(at7, "status", "todo").filter.status, []); // a second click clears it
  assert.equal(toggled(at7, "view", "ready").filter.view, "ready");
  assert.equal(toggled({ filter: { ...emptyFilter, view: "ready" }, page: 0 }, "view", "ready").filter.view, "all");
  // grouping is display-only: it does not change which rows match, so it keeps the page
  assert.equal(toggled(at7, "group", "none").page, 7);
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
