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
// this a subquery in the first place. It is still placed LAST and still compiled
// out entirely when no tag is selected.
//
// `overdue` compares against WALL-CLOCK time, so no write can ever be the moment it
// changes and it cannot be a stored fact. It is plain clauses (`[?t due ?due]`,
// `[< ?due {#utc …}]`) with the instant supplied by the read that builds the body.
// It used to be a literal baked in when the reactor was PROVISIONED, which went
// quietly wrong the moment the wall clock passed it and had been wrong for weeks.
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
// the priority STRING, which is alphabetical nonsense (high, low, med). `?t` is the
// final tiebreaker — real titles are not unique, and only a total order keeps an
// offset from dropping and repeating rows.
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
 * A multi-select, as an inlined literal comparison.
 *
 * This is the clause that replaced a four-clause value-join. One selected value is
 * a bare `=`; several are an `or` over `=`. Both are expressions over a var the
 * body has already bound by a fact clause, so they FILTER the candidate set rather
 * than joining anything to it — which is why they are faster than no filter at all.
 */
const anyOf = (v: string, values: readonly string[]): unknown[] =>
  values.length === 1 ? ["=", v, values[0]] : ["or", ...values.map((x) => ["=", v, x])];

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
 */
function inDomain(values: readonly string[], domain: readonly string[], what: string): readonly string[] {
  if (!values.length) return domain;
  for (const v of values) {
    if (!domain.includes(v)) throw new Error(`board ${what} filter: '${v}' is not one of ${domain.join(", ")}`);
  }
  return values;
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
  const status = inDomain(q.status, STATUS_DOMAIN, "status");
  const priority = inDomain(q.priority, PRIORITY_DOMAIN, "priority");
  if (!VIEW_DOMAIN.includes(q.view as (typeof VIEW_DOMAIN)[number])) {
    throw new Error(`board view: '${q.view}' is not one of ${VIEW_DOMAIN.join(", ")}`);
  }
  return {
    find: ["?t"],
    where: [
      // base todo facts, scoped to the workspace this server has open. The scope is
      // a LITERAL, not a var: nothing a client sends can move it.
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
      // The two facet filters, INLINED. Each was four clauses joining a session's
      // `sf` children against the row; each is now one expression over a var this
      // body already bound. Domain-checked above, which is what makes that safe.
      anyOf("?priority", priority),
      anyOf("?eff", status),
      // The derived view. It used to be an `or` over four branches tested against a
      // `?view` var joined off the session, because the session could change under
      // the body. The view is a compile-time value now, so only the branch that
      // applies is emitted at all — one comparison instead of four, and `all` emits
      // nothing.
      //
      // `overdue` is the branch that could never be expressed that way: it needs
      // `?due` bound by a fact clause, and a fact clause cannot be conditional, so
      // joining `due` unconditionally would silently drop every todo with no due
      // date.
      ...viewClauses(q),
      // Tag filter, LAST, and no longer a subquery: the todo's own list of labels,
      // plus a membership test over it. The labels reached this file having been
      // checked against the workspace's own tag vocabulary, and `tagClauses` checks
      // each one again on the way into the set literal.
      ...(q.tags.length ? tagClauses(q.tags) : []),
    ],
    orderBy: ["?prank", "?title"],
    // The window, if this body has one. `orderBy` ends with `?t`, so the order is
    // TOTAL — which is what makes an offset mean the same thing on two reads.
    // Without that last component two rows with equal (prank, title) could swap
    // between reads, and a page boundary falling between them would drop one row
    // and repeat the other; the harness's paging properties are what would catch it.
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

/** The clauses one derived view adds. `all` adds none. */
function viewClauses(q: BoardQuery): unknown[] {
  switch (q.view) {
    case "ready":
      return [["=", "?eff", "todo"]];
    case "done":
      return [["=", "?eff", "done"]];
    case "mine":
      return [["=", "?lastActor", q.actor]];
    case "overdue":
      return [
        ["?t", "due", "?due"],
        ["<", "?due", { "#utc": q.now.toISOString() }], // wall clock is not a fact
        ["!=", "?status", "done"],
      ];
    default:
      return [];
  }
}

/**
 * The current board PAGE — a one-shot dry-run, so it always recomputes.
 *
 * One read, where it used to be two: the session's facts had to be fetched before
 * the rows could be compiled, and the filter arrives with the request now.
 */
export async function readSnapshot(q: BoardQuery, page: number): Promise<Snapshot> {
  const rows = await query<SnapshotRow>(canonicalBody(q, pageWindow(page)));
  return { rows: rows.slice(0, PAGE_SIZE), page, hasMore: rows.length > PAGE_SIZE };
}
