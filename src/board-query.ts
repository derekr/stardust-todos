// The board's rows: one query, compiled per read from the filter in the URL.
//
// This file was `session.ts`, and it held a "search session in Stardust" — the
// filter as facts on a session entity, read back on every paint and inlined into
// the body. The facts are gone (see filter.ts for the three measurements that
// retired them); the COMPILER is what was worth keeping, and it is unchanged in
// shape. What used to be read out of the database is now read out of a query
// string, and what used to be joined off a session entity — viewer, actor,
// workspace — is inlined from values this process already holds authoritatively.
//
// The measurement that put the compiler here in the first place still stands, and
// it is the reason the filter is a parameter rather than a join in ANY encoding. At
// 5,005 todos, fifty rows, value indexes on, same corpus:
//
//   no facet filter at all (the floor)   51ms
//   the facet value-joins                1,972ms
//   the selected values inlined          24ms
//
// Unindexed the join is 32,775ms. Inlining is ~82x faster than joining and beats
// the unfiltered floor, because a literal comparison NARROWS the candidate set
// while a join adds work proportional to it. That is also the honest reading of
// what the "filters are facts" era actually bought by the end: nothing was
// EVALUATING those facts any more. The engine had already stopped joining them a
// commit before this one; all the facts still did was store a value the app read
// back and compiled in. A query string stores it too.
//
// What follows from a body that varies with the filter:
//
//   * There is no stored board reactor, in any shape. The body is a function of
//     the selection (15 x 7 x 5 x 2 x the tag vocabulary), so the rows are a
//     DRY-RUN per read — which costs what reading a stored reactor with a bind
//     costs anyway (27ms vs 29ms on the demo data), so the reactor was only ever
//     buying a subscription this file does not own.
//   * The body has NO free vars at all now. Session, viewer, actor, workspace and
//     the overdue clock are all literals, so the "an omitted bind matches
//     everything" hazard cannot apply to it — there is nothing left to omit.
//   * The app owns the correctness of a compiler, where before it owned a body. So
//     every value that reaches this file has been through a domain check in
//     filter.ts, and `canonicalBody` checks them AGAIN rather than trusting its
//     caller. Two checks over one boundary is the right number when the second one
//     is three lines.
//   * A deep page is the same read as page one: `limit`/`offset` are body fields
//     that refuse a bind, so a stored reactor could not have served page 20
//     without being created for it (31-44ms to create, 21-38ms to delete, and a
//     BLOCK of ~158 entity ids that never come back).
//
// The board is NOT the app's live subscription and has not been since the page-set
// landed: `page-rows` (queries.ts) is the standing reactor, bound to one page-set,
// whose cost is the page rather than the corpus. That is what wakes a reader; this
// file only answers "what is on the page right now".
//
// CLAUSE ORDER IS THE PLAN. The engine evaluates a `where` in the order it is
// written and does not reorder it, so the FIRST clause decides what the read starts
// from and everything after it is a filter over that. This file used to put the
// filter LAST — the facets as expressions over vars the base clauses had already
// bound — which meant every read began by walking the whole workspace in `prank`
// order and discarding rows. That is fine when the selection is dense and terrible
// when it is sparse, and the shape of the difference is exactly what `?st=blocked`
// was: 124 of 9,947 todos are blocked, and filling one 51-row window out of a 1.2%
// match set cost 193ms against 52ms for the unfiltered board. The identical body
// with `[?t effectiveStatus blocked]` written FIRST costs 26ms and returns the same
// 51 rows in the same order.
//
// So the rule this file follows: everything the filter narrows to comes first, and
// the clauses that are true of every todo come after it. Measured on the demo's
// 10,003 todos, one page, p50, tail-expression form → leading-clause form:
//
//   ?st=blocked            193ms → 27ms      ?pr=high              61ms → 50ms
//   ?st=doing               51ms → 23ms      ?pr=med (dense)      242ms → 176ms
//   ?st=todo (dense)        52ms → 33ms      ?st=blocked&pr=high  262ms → 29ms
//   ?st=blocked,done        49ms → 25ms      ?v=mine               49ms → 24ms
//   ?tag=design             47ms → 24ms      ?v=overdue            58ms → 34ms
//
// Every one of those returns byte-identical rows; the row count is what makes it a
// result rather than a guess. Nothing got slower, including the DENSE cases, which
// was the thing worth checking — a selection covering most of the workspace is the
// one where starting from the filter might have cost more than starting from the
// ordering index, and it does not. The unfiltered board emits no narrowing clause
// at all and is untouched at ~54ms.
//
// Two consequences that look alarming and are not. The workspace scope is no longer
// the first clause in the body — but it is still a LITERAL, still a conjunct, and
// still the only thing that decides which workspace a row can come from; a
// conjunction has no order, only a plan. And the tag clause is no longer LAST: it
// leads with the other narrowing clauses, which is worth 47ms → 24ms and is the
// same rule, not an exception to it.
//
// TAG LABELS are the one filter with no fixed domain — they are free text from
// `addTag` — so they are checked against the workspace's actual tag vocabulary
// (`availableTags`, which the render already reads) on the way in, and again by
// `tagLabel` on the way into the body.
//
// This clause was the app's LAST correlated `exists`, over the tag edges, and it
// was not slow, it was broken: a subquery's output is capped at 1,000 rows PER
// DIRECTIVE, so `?tag=design` took 82.7s, two labels 77.7s, and three labels
// refused outright while the app rendered an empty board. It is two plain clauses
// now — the todo's own `tags` list, and a membership test over it — because the
// todo carries its labels as a component as well as as edges (tags.ts holds the
// whole entry, including why one field per label cannot express two labels). One
// page went 104,475ms to 84ms, flat in the number of labels, and a todo carrying
// several selected labels still comes back once, which is the duplicate that made
// this a subquery in the first place. It is still compiled out entirely when no tag
// is selected.
//
// `overdue` compares against WALL-CLOCK time, so no write can ever be the moment it
// changes and it cannot be a stored fact. It is plain clauses (`[?t due ?due]`,
// `[< ?due {#utc …}]`) with the instant supplied by the read that builds the body.
// It used to be a literal baked in when the reactor was PROVISIONED, which went
// quietly wrong the moment the wall clock passed it and had been wrong for weeks.
// It is also the view that will not lead ENTIRELY, and the reason is worth more
// than the clause. `[?t due ?due]` hoisted to the front is a scan of every entity
// carrying a `due` field, not every TODO carrying one — and 89 of the demo's 2,087
// are SCHEMA entities, because a schema document names the properties it declares
// and `due` is one of them. They are filtered out again by `[?t app todo-app]` two
// clauses later, so the ANSWER was never wrong. What broke is the comparison: a
// schema's `due` is a ref, `[< ?due {#utc …}]` over a ref is `query: invalid
// argument type for <`, and it is an EVALUATION-time failure, so it appeared on
// `?v=overdue&tag=design&p=3` and not on `?v=overdue` — the shapes that stop after
// fifty-one rows never reach the bad one. A read that works on page 1 and 400s on
// page 4 is the worst version of this bug, and it is the one a paired timing
// measurement would have shipped.
//
// So the join leads and the COMPARISON trails, behind the clauses that make `?t` a
// todo. `[!= ?status done]` trails for the plainer reason that it reads a var those
// same clauses bind. 58ms → 34ms, against 29ms for the unsafe arrangement; 5ms is
// not worth a query that fails on a page nobody tested.
//
// The general rule, which the facet seeks satisfy for free: hoisting a clause
// changes WHAT IT SCANS. A clause matching a value (`[?t effectiveStatus blocked]`)
// narrows to rows that carry that value whatever else they are, and an expression
// over a var it bound is safe. A clause matching only a field's EXISTENCE narrows
// to every entity family that uses that field name, which is not the same set at
// all.
//
// Ordering is `orderBy [?prank ?title]`, and BOTH keys are value-indexed on
// purpose. Every key must be, or the engine abandons the index-ordered scan and
// sorts the whole visible set: measured at 10,003 todos, `[?prank ?title]` takes
// 36ms and `[?prank ?title ?t]` takes 252ms, because an entity var has no value
// index and cannot have one. That trailing `?t` also made the query ineligible for
// keyset pagination (`page_unsupported`), which the two-key form is not.
//
// It was there to force a TOTAL order so an offset means the same thing twice. Two
// rows tying on both priority and title now have no defined order between them, so
// the harness's paging properties are what stand behind this — they page the whole
// corpus and assert the concatenation equals the unpaginated read, in order.
//
// `prank` is the priority ORDINAL
// (high 0, med 1, low 2), so ascending is high→med→low; the board used to order by
// the priority STRING, which is alphabetical nonsense (high, low, med).
//
// WHAT COSTS IS THE LEADING KEY, not the number of them, and that is the second
// thing worth carrying out of this file. `orderBy [?title ?prank]` is 6ms on the
// unfiltered board and `orderBy [?prank ?title]` is 47ms — two keys either way. A
// key with three distinct values cannot drive an index-ordered scan the way a
// near-unique one can, so leading with `prank` means the whole visible set is
// materialised and sorted, and leading with `title` means walking an index until
// fifty-one rows have passed. (`orderBy` omitted entirely is 290ms, so the index
// scan is doing real work either way — this is about which key drives it.)
//
// That is why `orderBy` is a function of the filter and not a constant. When the
// priority selection pins a SINGLE value, every matching row has the same `prank`,
// so ordering by it is provably a no-op and the key is dropped — leaving `?title`,
// which is near-unique, to lead. Measured on the demo, same 51 rows in the same
// order: `?pr=med` 184ms → 6ms, `?pr=low` 122ms → 8ms, `?pr=high` 60ms → 8ms. The
// board's own order is unchanged, which is the property that makes this legal
// rather than a trade: within one priority, "by prank then title" IS "by title".
//
// The unfiltered board still pays the ~47ms, and the fix for that is a single
// near-unique ordering key it does not have — a stored `prank`-then-title composite
// written by the same write path that maintains `prank`. That is a field, an index,
// a backfill and a reconciliation check, and it was deliberately not bundled in
// here; AGENTS.md records it as the next lever with the numbers.
//
// The board DERIVES nothing per row, and with the tag clause rewritten it now runs
// NO SUBQUERY AT ALL. `blocked`, `effectiveStatus` and `prank` are stored facts
// written by the transaction that causes them (todos.ts, `refreshDerived`) and
// `tags` is one written by `addTag`/`removeTag` (tags.ts), so this body JOINS all
// four. That is the same lesson reached twice, from two different ceilings: a
// correlated subquery is executed once per candidate ROW against a budget of 10,000
// executions for the whole query, AND its output is capped at 1,000 rows per
// directive — so a per-row subquery does not degrade with the corpus, it hard-FAILS
// at some size, and `limit` cannot rescue either one, being a post-filter that
// neither reduces executions nor raises a ceiling.

import { type EntityId, query } from "./stardust.ts";
import { type Filter, PRIORITY_DOMAIN, STATUS_DOMAIN, VIEW_DOMAIN } from "./filter.ts";
import { tagClauses } from "./tags.ts";
import { APP } from "./tenancy.ts";

/**
 * Rows per page. 51 are asked for and 50 are shown: the extra row is how the
 * board knows there is a next page WITHOUT a second query.
 *
 * That is not a micro-optimisation, it is the whole reason the count pill says
 * "50+" rather than a number. `find[[count ?t]]` over the board's own `where` was
 * measured at 7.5s against 2,000 unindexed todos — the same 7.6s the board itself
 * costs, because the count still evaluates every clause and only the projection is
 * cheaper. A total therefore DOUBLES the work of every page view, which is a lot to
 * pay for a numeral. The 51st row costs nothing and answers the only question the
 * pager actually asks.
 */
export const PAGE_SIZE = 50;

/**
 * A page of the board, as the body expresses it.
 *
 * `limit` and `offset` are BODY fields, not bind vars — `limit ?n` is refused with
 * `query: limit must be number`, and so is `offset ?off` and `{#bind off}`.
 */
export interface PageWindow {
  limit: number;
  offset: number;
}

/** The window a page index reads: one more row than it shows, to detect a next page. */
export const pageWindow = (page: number): PageWindow => ({ limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE });

/** One board row as the body projects it. Reachable as `Snapshot["rows"][number]`
 *  rather than exported: a caller wants the page, not a loose row type. */
interface SnapshotRow {
  id: EntityId;
  title: string;
  status: string; // user intent, never "blocked"
  priority: string;
  effectiveStatus: string; // STORED (todos.ts, refreshDerived) — joined, not derived
  done: boolean;
  blocked: boolean; // STORED — ditto
  draft?: boolean;
  lastActor?: string;
}

/** One page of the board: the rows to render, which page they are, and whether a
 *  next one exists (the 51st row, never rendered). */
export interface Snapshot {
  rows: SnapshotRow[];
  page: number;
  hasMore: boolean;
}

/**
 * Who is asking, as the server knows it.
 *
 * These three used to be facts on the session and joined off it. They are the half
 * of the board's inputs the CLIENT does not get to supply — a browser sends a
 * filter, never a workspace or a persona — so they are inlined from process state
 * and the URL cannot widen the scope it is read in.
 */
export interface BoardScope {
  workspace: EntityId;
  viewer: EntityId; // the persona whose drafts are visible
  actor: string; // the name `view=mine` matches against `lastActor`
}

/**
 * Everything a board body needs that is not fixed: who is asking, what they have
 * narrowed to, and the instant `overdue` means.
 */
export interface BoardQuery extends BoardScope {
  /** selected effective statuses; empty means the whole domain */
  status: readonly string[];
  /** selected priorities; empty means the whole domain */
  priority: readonly string[];
  /** selected tag labels; empty means no tag clause at all */
  tags: readonly string[];
  /** the view — one of VIEW_DOMAIN */
  view: string;
  /** the instant `overdue` compares against. Wall clock, so it belongs to the READ */
  now: Date;
}

/** The BoardQuery a scope and a filter describe. */
export const boardQuery = (scope: BoardScope, f: Filter, now: Date = new Date()): BoardQuery => ({
  ...scope,
  status: f.status,
  priority: f.priority,
  tags: f.tags,
  view: f.view,
  now,
});

/**
 * One narrowing the filter contributes — the clauses it emits, and the var the
 * four-clause value-join these replaced used to bind.
 *
 * The GROUP is the unit rather than the clause because a multi-value selection
 * takes two clauses to say, and because the stress harness swaps a whole group back
 * out for the value-join it replaced. Handing it loose clauses would make it guess
 * which ones belonged together.
 */
export interface Narrowing {
  /** `?eff` or `?priority` — the var the value-join bound */
  narrows: string;
  /** in emission order: one clause for a single value, two for several */
  clauses: unknown[][];
}

/**
 * A multi-select, as the clause the read STARTS from — or as NOTHING when the
 * selection covers the whole domain.
 *
 * This is the clause that replaced a four-clause value-join, and it has now moved
 * twice. It was a join; then it became an inlined `=` (or an `or` over `=`) sitting
 * at the END of the body, which is worth 82x because a literal narrows the
 * candidate set where a join adds work proportional to it; and it is a FACT clause
 * at the FRONT of the body now, which is worth another 7x on a sparse selection,
 * because an expression can only filter rows something else already produced. Same
 * lesson each time, one step further along it: the earlier the engine knows a
 * value, the less it has to look at.
 *
 * The two spellings are not interchangeable and the difference is measured. A
 * single value is a LITERAL in the fact clause, which is an index seek: 26ms for
 * `?st=blocked`. Several values cannot be, so they bind a var of their own and test
 * membership over it — 25ms for `?st=blocked,done`, and 40ms if the same
 * two-clause shape is used for a single value, which is why the single case is
 * spelled separately rather than uniformly.
 *
 * The var is a fresh one (`?effIn`) rather than the `?eff` the base clauses bind,
 * and that is deliberate too: reusing `?eff` means dropping the base clause and
 * letting this one bind the projection's value, which measured SLOWER (43ms against
 * 40ms). The redundant-looking second clause over an already-narrowed set is
 * cheaper than moving the binding.
 *
 * The empty case used to be spelled as the whole domain, so an unfiltered board
 * carried `[or [= ?priority low] [= ?priority med] [= ?priority high]]` and a
 * four-branch twin for `?eff`. Those are expressions with no candidate rows to
 * remove: every value the fact clause can bind is already a branch, so the engine
 * evaluated seven comparisons per row of the workspace to reach the same answer.
 * Measured on the demo at 10,003 todos, one unfiltered page went 85ms to 54ms with
 * the two of them gone — a third of the read — byte-identical rows and the same
 * 9,947 matching the unwindowed body. A filter that filters nothing is not free,
 * and it looks exactly like one that does; the only reason this was visible at all
 * is that the clause it replaced was the expensive one.
 *
 * `null` rather than an empty group so the caller has to decide what "no clause"
 * means, and because a selection covering the domain must emit nothing at all.
 */
const seek = (field: string, v: string, values: readonly string[], domain: readonly string[]): Narrowing | null => {
  if (values.length >= domain.length) return null; // nothing left to narrow
  const held = `${v}In`;
  return {
    narrows: v,
    clauses:
      values.length === 1
        ? [["?t", field, values[0]!]]
        : [
            ["?t", field, held],
            ["contains", { "#set": [...values] }, held],
          ],
  };
};

/**
 * A selection, checked against its domain — the guard that makes inlining safe.
 *
 * An empty selection means "all", so it becomes the whole domain rather than an
 * empty `or` (which is not a clause). Anything outside the domain THROWS.
 *
 * filter.ts already refused these values on the way in from the URL, so this is
 * the second check over one boundary. It stays because this function is also
 * reachable from the CLI, the stress harness and any future caller that did not
 * come through a URL, and because the cost of the check is three lines against a
 * failure mode that is a query matching the wrong rows.
 *
 * It still MATERIALIZES the empty case into the domain, even though `seek` then
 * emits no clause for it. "Select nothing" and "select everything" are the same
 * board — the chips let a reader tick all four statuses — and they must compile to
 * the same body, which is easiest to guarantee by making them the same VALUE first.
 */
function inDomain(values: readonly string[], domain: readonly string[], what: string): readonly string[] {
  if (!values.length) return domain;
  for (const v of values) {
    if (!domain.includes(v)) throw new Error(`board ${what} filter: '${v}' is not one of ${domain.join(", ")}`);
  }
  return values;
}

/**
 * The narrowings one selection pair contributes — two, one, or none at all.
 *
 * Status before priority, because that is the order that measured best on a board
 * carrying both (`?st=blocked&pr=high`: 28ms leading with the status, 32ms leading
 * with the priority) — and because nothing here can know a selection's real
 * selectivity, only that a narrowed facet is narrower than no facet. The honest
 * shape of the rule is "the filter before the corpus", not "the most selective
 * clause first"; the app does not have the statistics for the second one.
 *
 * Exported because the stress harness reconstructs the value-join these replaced by
 * finding them in the body, and it must look for exactly what was emitted.
 */
export function facetClauses(q: BoardQuery): Narrowing[] {
  const s = seek("effectiveStatus", "?eff", inDomain(q.status, STATUS_DOMAIN, "status"), STATUS_DOMAIN);
  const p = seek("priority", "?priority", inDomain(q.priority, PRIORITY_DOMAIN, "priority"), PRIORITY_DOMAIN);
  return [s, p].filter((c) => c !== null);
}

/**
 * The canonical board body, for ONE filter and ONE page.
 *
 * `window` is a REQUIRED argument with no default, and that is deliberate. A body
 * silently defaulting to "every matching row" is the shape of bug this exists to
 * prevent, and a body silently defaulting to page 0 would make an oracle that
 * compares against the whole corpus quietly compare against fifty rows. Passing
 * `null` means "no window" and has to be typed out.
 */
export function canonicalBody(q: BoardQuery, window: PageWindow | null): Record<string, unknown> {
  const facets = facetClauses(q); // domain-checked in here, before anything else
  if (!VIEW_DOMAIN.includes(q.view as (typeof VIEW_DOMAIN)[number])) {
    throw new Error(`board view: '${q.view}' is not one of ${VIEW_DOMAIN.join(", ")}`);
  }
  return {
    find: ["?t"],
    where: [
      // ---- what the FILTER narrows to, first --------------------------------
      //
      // The engine does not reorder a `where`, so these decide what the read
      // starts from. Every one is a fact clause with a literal or a set the app
      // domain-checked, and every one is absent when its facet is not narrowed —
      // an unfiltered board reaches the next section with nothing in front of it.
      // See the header for the before/after table; the short version is 193ms →
      // 27ms for `?st=blocked` and not one case slower.
      ...facets.flatMap((f) => f.clauses),
      // The derived view, as clauses that can SEEK. It used to be an `or` over four
      // branches tested against a `?view` var joined off the session, because the
      // session could change under the body. The view is a compile-time value now,
      // so only the branch that applies is emitted at all, and `all` emits nothing.
      ...viewLead(q),
      // Tag filter: the todo's own list of labels, plus a membership test over it.
      // The labels reached this file having been checked against the workspace's
      // own tag vocabulary, and `tagClauses` checks each one again on the way into
      // the set literal.
      ...(q.tags.length ? tagClauses(q.tags) : []),
      // ---- the todo, and who may see it -------------------------------------
      //
      // True of every row in the workspace, so nothing here narrows anything and
      // the order among them does not matter. The scope is a LITERAL, not a var:
      // nothing a client sends can move it, whichever clause it is written on.
      ["?t", "app", APP],
      ["?t", "workspace", { "#": q.workspace }],
      ["?t", "status", "?status"],
      ["?t", "priority", "?priority"],
      ["?t", "title", "?title"],
      ["?t", "done", "?done"],
      ["?t", "draft", "?draft"],
      ["?t", "author", "?author"],
      ["?t", "lastActor", "?lastActor"],
      // the derived facts, JOINED — recorded by the write that caused them
      ["?t", "blocked", "?blocked"],
      ["?t", "effectiveStatus", "?eff"],
      ["?t", "prank", "?prank"], // the ordering key (high 0, med 1, low 2)
      // viewer visibility (published OR authored by the viewer)
      ["or", ["=", "?draft", false], ["=", "?author", { "#": q.viewer }]],
      // ---- the filter tests that cannot lead --------------------------------
      //
      // `overdue`'s two expressions. "Not done" reads `?status`, which the section
      // above binds, and an expression running before its var is bound is
      // `query_failed: unbound input var`. The date comparison is subtler and is
      // why this section exists at all: the clauses above are what make `?t` a
      // TODO, and a `due` read off anything else — a schema document declaring the
      // property, say — is a ref that `<` refuses. Both failures are
      // evaluation-time, so they surface on a deep page and not on page one.
      ...viewTail(q),
    ],
    orderBy: orderBy(q),
    // The window, if this body has one. Two rows tying on (prank, title) have no
    // defined order between them; the harness's paging properties are what stand
    // behind that, by paging the whole corpus and asserting the concatenation
    // equals the unpaginated read, in order.
    ...window,
    then: {
      project: {
        id: "?t",
        title: "?title",
        status: "?status",
        priority: "?priority",
        effectiveStatus: "?eff",
        done: "?done",
        blocked: "?blocked",
        draft: "?draft",
        lastActor: "?lastActor",
      },
    },
  };
}

/**
 * The ordering keys, which are a function of the FILTER rather than a constant.
 *
 * `[?prank ?title]` is the board's order: ascending prank is high→med→low, then
 * title. What it costs is the LEADING key — `prank` has three distinct values, so
 * it cannot drive an index-ordered scan and the whole visible set is materialised
 * and sorted (47ms on the demo, against 6ms for the same two keys the other way
 * round, and 290ms with no `orderBy` at all).
 *
 * So when the priority selection pins a SINGLE value, `prank` is constant across
 * every row the body can return and ordering by it is a no-op. Dropping it leaves
 * `?title` — near-unique, and therefore able to lead a scan — and the board's order
 * is not merely preserved but identical: within one priority, "prank then title" IS
 * "title". Measured on the demo, same 51 rows in the same order, `?pr=med` 184ms →
 * 6ms, `?pr=low` 122ms → 8ms, `?pr=high` 60ms → 8ms.
 *
 * The general form, which is worth more than the special case: an ordering key a
 * filter has made CONSTANT is not free, it is the most expensive part of the read.
 */
function orderBy(q: BoardQuery): string[] {
  const pinned = inDomain(q.priority, PRIORITY_DOMAIN, "priority").length === 1;
  return pinned ? ["?title"] : ["?prank", "?title"];
}

/**
 * The clauses one derived view adds AT THE FRONT — the ones that can seek.
 *
 * `ready`/`done` are a value on `effectiveStatus` and `mine` one on `lastActor`, so
 * all three are index seeks. `overdue` needs `?due` bound by a fact clause, and a
 * fact clause cannot be conditional — joining `due` unconditionally would silently
 * drop every todo with no due date — so it leads with the join and the comparison
 * and leaves its "not done" test to `viewTail`. `all` adds nothing.
 */
function viewLead(q: BoardQuery): unknown[][] {
  switch (q.view) {
    case "ready":
      return [["?t", "effectiveStatus", "todo"]];
    case "done":
      return [["?t", "effectiveStatus", "done"]];
    case "mine":
      return [["?t", "lastActor", q.actor]];
    case "overdue":
      // The JOIN only. Its comparison is in `viewTail` — see the header: this clause
      // matches a field's EXISTENCE, so hoisting it scans every entity family that
      // uses the name `due`, schema documents included, and their `due` is a ref
      // that `<` refuses at evaluation time on whichever page first reaches one.
      return [["?t", "due", "?due"]];
    default:
      return [];
  }
}

/** The view clauses that must run AFTER the base ones — either because they read a
 *  var those clauses bind, or because those clauses are what make `?t` a todo and
 *  therefore what makes `?due` an instant. */
const viewTail = (q: BoardQuery): unknown[][] =>
  q.view === "overdue"
    ? [
        ["<", "?due", { "#utc": q.now.toISOString() }], // wall clock is not a fact
        ["!=", "?status", "done"],
      ]
    : [];

/**
 * How many rows the window at `page` could hold, given an upper bound on how many
 * rows the whole board could have. Zero means the page is past the end.
 *
 * The bound is the count chips' total — the workspace's VISIBLE todos, not narrowed
 * by the filter — so it is an over-estimate of a filtered board and an exact answer
 * for an unfiltered one. Over-estimating is the safe direction and the only reason
 * this is sound: if the offset is past even the unfiltered total, no filter can put
 * a row there.
 */
export const windowRows = (page: number, bound: number): number =>
  Math.max(0, Math.min(PAGE_SIZE + 1, bound - page * PAGE_SIZE));

/**
 * The current board PAGE — a one-shot dry-run, so it always recomputes.
 *
 * One read, where it used to be two: the session's facts had to be fetched before
 * the rows could be compiled, and the filter arrives with the request now.
 *
 * `bound` is what makes `?page=200` cheap. Walking to an offset beyond the end is a
 * full scan that returns nothing — measured at 285.9ms and 303ms on the demo, twice,
 * for zero rows — because `offset` is applied after the work rather than instead of
 * it, the same way `limit` is (see the header). The process usually already knows
 * the answer: the chips' tally is in memory, so a page past THAT is a page past
 * every filtered subset of it, and the read is skipped rather than executed.
 *
 * What it costs is honesty about staleness, and it is worth stating rather than
 * hiding. The tally is the last emission of a subscription, so a write that lands
 * between that emission and this read makes the bound momentarily low; a page turn
 * to the very end, at the instant a write extends the board past it, can paint an
 * empty page that a repaint fills in. The alternative was a 300ms scan on every
 * arrival at an out-of-range URL, and a bound that is absent (a cold scope) simply
 * disables the guard.
 */
export async function readSnapshot(q: BoardQuery, page: number, bound?: number): Promise<Snapshot> {
  if (bound !== undefined && windowRows(page, bound) === 0) return { rows: [], page, hasMore: false };
  const rows = await query<SnapshotRow>(canonicalBody(q, pageWindow(page)));
  return { rows: rows.slice(0, PAGE_SIZE), page, hasMore: rows.length > PAGE_SIZE };
}
