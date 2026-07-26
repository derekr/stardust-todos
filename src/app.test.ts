// Unit tests for the pure logic — no live Stardust needed. Run: `npm test`
// (node:test runs .ts natively via Node's type stripping; the integration
// coverage lives in the demo:* scripts, which exercise a real Stardust instance.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleTo } from "./derive.ts";
import { effectiveStatus } from "./board.ts";
import { PAGE_SIZE, PLAIN_SHAPE, boardReactorName, boardShape, canonicalBody, pageWindow } from "./session.ts";
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

test("the plain board body executes NO subqueries and joins the stored fields", () => {
  const body = canonicalBody(PLAIN_SHAPE, null) as { where: unknown[]; orderBy: string[] };
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

test("the shaped bodies add exactly the clause they are named for", () => {
  const clauses = (s: Parameters<typeof canonicalBody>[0]) =>
    JSON.stringify((canonicalBody(s, null) as { where: unknown[] }).where);
  assert.equal(clauses({ tag: true, overdue: false }).includes("exists"), true);
  assert.equal(clauses({ tag: false, overdue: true }).includes("exists"), false); // plain clauses
  assert.equal(clauses({ tag: false, overdue: true }).includes('["<","?due","?now"]'), true);
  assert.equal(clauses(PLAIN_SHAPE).includes("?due"), false);
});

test("a page window is limit/offset on the body, and asks for one row too many", () => {
  // The 51st row is what tells the pager there is a next page. A query that
  // returned exactly PAGE_SIZE could not distinguish "a full page" from "the end",
  // and the alternative — counting — costs a second full evaluation of the board.
  assert.deepEqual(pageWindow(0), { limit: PAGE_SIZE + 1, offset: 0 });
  assert.deepEqual(pageWindow(3), { limit: PAGE_SIZE + 1, offset: 3 * PAGE_SIZE });

  const windowed = canonicalBody(PLAIN_SHAPE, pageWindow(2)) as Record<string, unknown>;
  assert.equal(windowed.limit, PAGE_SIZE + 1);
  assert.equal(windowed.offset, 2 * PAGE_SIZE);
  // and no window means no window — the oracle in scripts/stress reads this body
  const unpaged = canonicalBody(PLAIN_SHAPE, null) as Record<string, unknown>;
  assert.equal("limit" in unpaged, false);
  assert.equal("offset" in unpaged, false);
  // offset paging is only meaningful over a TOTAL order; ?t is the tiebreaker
  assert.deepEqual((windowed as { orderBy: string[] }).orderBy, ["?prank", "?title", "?t"]);
});

test("boardShape/boardReactorName name one reactor per shape", () => {
  const of = (tags: string[], view: "all" | "overdue") => boardReactorName(boardShape({ tags, view }));
  assert.equal(of([], "all"), "board");
  assert.equal(of(["alpha"], "all"), "board-tag");
  assert.equal(of([], "overdue"), "board-overdue");
  assert.equal(of(["alpha"], "overdue"), "board-overdue-tag");
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
