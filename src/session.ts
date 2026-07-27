// A "search session" that lives in Stardust — the SINGLE source of truth.
//
// The filter state is facts (a `session` entity + `sf` facet child entities). That
// has not changed and is not negotiable: two browsers have two sessions, so they
// have two filters, and this process holds none of it. What changed is how those
// facts reach the query. They used to be JOINED — the body carried
// `[?fp facet priority] [?fp value ?priority]` and the engine matched every
// candidate row against the session's facet children. Now they are READ and
// INLINED: `readSnapshot` reads the session back, checks each selected value
// against its domain, and compiles it into the body as a literal comparison.
//
// That is the whole of this change, and it was made for one measurement. At 5,005
// todos, fifty rows, value indexes on, same corpus:
//
//   no facet filter at all (the floor)   51ms
//   the facet value-joins                1,972ms
//   the selected values inlined          24ms
//
// Unindexed the join is 32,775ms. Inlining is ~82x faster than joining and beats
// the unfiltered floor, because a literal comparison NARROWS the candidate set
// while a join adds work proportional to it — the facet rows are matched against
// every row that reaches them, and a session that has selected all four statuses
// carries four of them.
//
// What it costs is that one stored body no longer serves every filter combination.
// The body is a function of the selection now, and there are 15 x 7 x 5 x 2 of
// those, so provisioning a reactor per shape is not a thing that can be done. The
// board's rows are a DRY-RUN — one `POST /reactors/dry-run` per read, no stored
// state, no reactor to create and delete. Everything else follows from that:
//
//   * A dry-run has no bind, so the session is selected by an inlined `sid` and the
//     overdue clock by an inlined `{#utc …}`. The body therefore has NO free vars,
//     which retires the whole "an omitted bind matches everything" hazard for this
//     query — there is nothing left to omit. It also means the body cannot be
//     handed to a browser as a reactor id plus a scope; it never was, and the
//     browser still holds only its sid.
//   * A page past the first cost an EPHEMERAL REACTOR before (31-44ms to create,
//     21-38ms to delete, ~158 entity ids burned per page view, because every clause
//     is an entity and deleting the reactor does not give them back). `limit` and
//     `offset` are body fields that refuse a bind, so a deep page could not be
//     reached by parameterising a stored reactor. A dry-run has the same
//     indifference to the window that it has to the filter, so deep paging is now
//     the same read as page one and costs the same.
//
// The board is NOT the app's live subscription and has not been since the page-set
// landed: `session-page` (queries.ts) is the standing reactor, bound by `sid`,
// whose cost is the page rather than the corpus. That is what wakes a reader, and
// this file only answers "what is on the page right now".
//
// Two things are deliberately NOT inlined.
//
//   * TAG LABELS. Statuses, priorities and views come from fixed domains, so
//     checking a value against its domain before it enters the body is a complete
//     argument that nothing else can. A tag label is user-entered free text
//     (`addTag`), and there is no domain to check it against — so the tag filter
//     stays exactly what it was: the one surviving correlated `exists`, correlated
//     to the session's own `sf` rows, placed LAST where the fewest rows reach it,
//     and compiled out entirely when no tag is selected. It keeps a ceiling of its
//     own, roughly "however many rows reach the clause".
//
//     Worth being precise about why the domain check is sufficient for the rest.
//     The app builds query bodies as JS STRUCTURES and serialises them as JSON at
//     the wire; it never string-builds RON. A value lands in an array cell, not in
//     a position where a quote could end a literal early. The domain check is
//     belt to that braces: it is what makes an unknown value a loud refusal
//     instead of a body that matches nothing.
//   * The VIEW. It is still `[?sess view ?view]` plus an expression over the bound
//     var, because it is a single-select compared against constants that were
//     already literals — there was nothing to join and nothing to gain.
//
// `overdue` compares against WALL-CLOCK time, so no write can ever be the moment it
// changes and it cannot be a stored fact. It is plain clauses (`[?t due ?due]`,
// `[< ?due {#utc …}]`) with the instant supplied by the read that builds the body.
// It used to be a literal baked in when the reactor was PROVISIONED, which went
// quietly wrong the moment the wall clock passed it and had been wrong for weeks; a
// per-read body is stale for the length of one read.
//
// Ordering is `orderBy [?prank ?title ?t]`. `prank` is the priority ORDINAL
// (high 0, med 1, low 2), so ascending is high→med→low; the board used to order by
// the priority STRING, which is alphabetical nonsense (high, low, med). `?t` is the
// final tiebreaker — real titles are not unique, and only a total order keeps an
// offset from dropping and repeating rows.
//
// The board no longer DERIVES anything per row either. `blocked`, `effectiveStatus`
// and `prank` are stored facts, written by the transaction that causes them
// (todos.ts, `refreshDerived`), so this body JOINS them — `[?t effectiveStatus ?eff]`
// where it used to run a correlated `exists` and then a `cond` over the result. A
// correlated subquery is executed once per candidate ROW against a budget of 10,000
// executions shared by the ENTIRE query, so the three of them here did not degrade
// past a few thousand todos, they hard-FAILED — and `limit` cannot rescue it, being
// a post-filter that neither reduces executions nor raises the ceiling.
//
// The board returns ONE PAGE, not every matching row: `limit`/`offset` on the body,
// fifty rows shown and a fifty-first read to know whether there is a next page. Be
// precise about what that buys, because the obvious claim is wrong. `limit` is a
// POST-FILTER: at 2,000 unindexed todos the plain body costs 7.6s unlimited, 7.5s
// with `limit 50`, and 7.5s with `limit 50 offset 1000`, and a bare
// `find[[count ?t]]` over the identical `where` costs the same 7.5s. The engine
// evaluates every clause and then throws rows away. So paging bounds the RESPONSE,
// the render and the memory a result set occupies; it does not bound the query.
// Narrowing the FILTER does bound the query, which is the point of this change.

import { type EntityId, createSchemaEntity, patchSchemaEntity, query, readEntity, transact } from "./stardust.ts";
import { sessionSchema } from "./schemas.ts";
import { validators } from "./field-registry.ts";
import type { Filter } from "./board.ts";
import { APP } from "./tenancy.ts";

// The three fixed domains. Every value that is compiled into a board body as a
// LITERAL is checked against one of these first — that check is the reason
// inlining is safe, so it is not optional and it throws rather than skipping.
//
// The status facet filters on the STORED `effectiveStatus`, so "blocked" is one of
// its values. Priorities as stored. An empty facet means "all", materialized as the
// whole domain when it is written (an absent join used to match nothing) and read
// back the same way here.
const STATUS_DOMAIN = ["todo", "doing", "blocked", "done"] as const;
const PRIORITY_DOMAIN = ["low", "med", "high"] as const;
/** The same enum the session schema declares for `view` — kept in step by hand,
 *  because the schema rejects a bad write and this rejects a bad READ. */
const VIEW_DOMAIN = ["all", "ready", "overdue", "mine", "done"] as const;

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
 * `query: limit must be number`, and so is `offset ?off` and `{#bind off}`. That
 * used to force a page past the first to be a reactor of its own, created for the
 * read and deleted after it. The body is built per read now, so a window is just
 * two more numbers in it.
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

export interface SessionHandle {
  sessionId: EntityId;
  workspaceId: EntityId;
}

/** One page of the board: the rows to render, which page they are, and whether a
 *  next one exists (the 51st row, never rendered). */
export interface Snapshot {
  rows: SnapshotRow[];
  page: number;
  hasMore: boolean;
}

/**
 * Everything a board body needs that is not fixed: the session it answers for, the
 * values it inlines, and the two clause groups it may carry.
 *
 * This is the app-side form of facts the session already holds. The session stays
 * the source of truth — `readSessionState` is where these come from on every read
 * — and this type exists so the compiler asks for all of them at once rather than
 * letting a caller build half a filter.
 */
export interface BoardQuery {
  /** the session, selected by its `sid` — a literal, since a dry-run has no bind */
  sid: EntityId;
  /** selected effective statuses; empty means the whole domain */
  status: readonly string[];
  /** selected priorities; empty means the whole domain */
  priority: readonly string[];
  /** the session's view — one of VIEW_DOMAIN */
  view: string;
  /** the session has ≥1 tag selected: carry the one remaining correlated `exists` */
  tag: boolean;
  /** the instant `overdue` compares against. Wall clock, so it belongs to the READ */
  now: Date;
}

/** The BoardQuery a session's filter describes. The tag LIST is not carried: the
 *  labels are free text and stay in the correlated subquery, which reads them from
 *  the session's own facts. Only "is the tag filter on" crosses over. */
export const boardQuery = (sid: EntityId, f: Filter, now: Date = new Date()): BoardQuery => ({
  sid,
  status: f.status,
  priority: f.priority,
  view: f.view,
  tag: f.tags.length > 0,
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
 * empty `or` (which is not a clause). Anything outside the domain THROWS: this is
 * the boundary where a value stops being data and starts being query, and the only
 * safe answers are "a value I recognise" and "no".
 */
function inDomain(values: readonly string[], domain: readonly string[], what: string): readonly string[] {
  if (!values.length) return domain;
  for (const v of values) {
    if (!domain.includes(v)) throw new Error(`board ${what} filter: '${v}' is not one of ${domain.join(", ")}`);
  }
  return values;
}

const tagSub = {
  capture: { t: "?t", sess: "?sess" },
  find: ["?e"],
  where: [
    ["?e", "kind", "tag"],
    ["?e", "todo", "?t"],
    ["?e", "label", "?l"],
    ["?ft", "kind", "sf"],
    ["?ft", "session", "?sess"],
    ["?ft", "facet", "tag"],
    ["?ft", "value", "?l"],
  ],
};

/**
 * The canonical board body, for ONE session's current filter and ONE page.
 *
 * A session is selected by its `sid`, inlined; its scalar fields (viewer/view/
 * actor/tagActive/workspace) are still joined off the session entity, because they
 * are one row and the join is what keeps the session the source of truth. The
 * facet MULTI-SELECTS are the part that is inlined — see the file header for the
 * measurement that motivated it and for why tag labels are not.
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
  const overdue = q.view === "overdue";
  return {
    find: ["?t"],
    where: [
      ["?sess", "kind", "session"],
      ["?sess", "sid", q.sid], // inlined: a dry-run has no bind, and this one is ours
      ["?sess", "viewer", "?viewer"],
      ["?sess", "view", "?view"],
      ["?sess", "actor", "?actor"],
      ["?sess", "workspace", "?ws"],
      // base todo facts
      ["?t", "app", APP],
      ["?t", "workspace", "?ws"],
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
      // viewer visibility (published OR authored by viewer)
      ["or", ["=", "?draft", false], ["=", "?author", "?viewer"]],
      // The two facet filters, INLINED. Each was four clauses joining the session's
      // `sf` children against the row; each is now one expression over a var this
      // body already bound. Domain-checked above, which is what makes that safe.
      anyOf("?priority", priority),
      anyOf("?eff", status),
      // derived-view filter (single-select), all over BOUND vars.
      //
      // `overdue` is not one of them: it needs `?due` bound by a fact clause, and a
      // fact clause cannot be conditional — joining `due` would silently drop every
      // todo that has no due date. So the overdue body REPLACES the `or` with the
      // plain clauses plus a guard, and every other view keeps the `or` without an
      // overdue branch. The guard is kept even though this body was built from the
      // same `view` fact it tests: it means a body and a session that have drifted
      // apart return NOTHING rather than something wrong.
      ...(overdue
        ? [
            ["=", "?view", "overdue"],
            ["?t", "due", "?due"],
            ["<", "?due", { "#utc": q.now.toISOString() }], // wall clock is not a fact
            ["!=", "?status", "done"],
          ]
        : [
            [
              "or",
              ["=", "?view", "all"],
              ["and", ["=", "?view", "ready"], ["=", "?eff", "todo"]],
              ["and", ["=", "?view", "done"], ["=", "?eff", "done"]],
              ["and", ["=", "?view", "mine"], ["=", "?lastActor", "?actor"]],
            ],
          ]),
      // Tag filter, LAST: the one correlated `exists` left, and the one filter that
      // is NOT inlined, because a tag label is free text with no domain to check it
      // against. It runs against the smallest row set the rest of the body can hand
      // it. It cannot become a plain join either: a todo carrying two selected
      // labels would come back twice (the harness caught exactly that). `tagActive`
      // is read here too, so the body is still correct when the last tag chip is
      // deselected between the read of the session and the read of the rows.
      ...(q.tag
        ? [
            ["?sess", "tagActive", "?tagActive"],
            [["exists", tagSub], "?hasTag"],
            ["or", ["not", "?tagActive"], "?hasTag"],
          ]
        : []),
    ],
    orderBy: ["?prank", "?title", "?t"],
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

/**
 * Rewrite ALL of a session's facets in ONE transaction.
 *
 * It used to be a delete-then-create loop per facet — roughly fifteen
 * transactions for one filter click. Every one of them invalidated the board
 * reactor, so a subscriber watching the bound results stream saw the half-written
 * states go by: measured, a single filter change emitted six results with row
 * counts 8, 3, 8, 1, 8, 3. One transaction means one recompute, straight to the
 * final answer.
 *
 * The cost is that these rows no longer go through the `sf` schema — a transact
 * writes facts unchecked, and there is no batch form of
 * `POST /schemas/{id}/entities`. So the values are checked here first, against the
 * SAME generated validators the schema produces. That is a weaker guarantee (the
 * app asserting it, not the engine enforcing it) and worth knowing about; the
 * session's own scalars still go through their schema below, which is where the
 * enum that matters (`view`) lives. It is also no longer the only check on these
 * values: anything that gets inlined into a board body is checked AGAIN against
 * its domain on the way in, which is the check that has to hold.
 */
async function writeFacets(sessionId: EntityId, spec: { facet: string; values: readonly string[] }[]): Promise<void> {
  const existing = (await query({
    find: ["?f"],
    where: [
      ["?f", "kind", "sf"],
      ["?f", "session", { "#": sessionId }],
    ],
  })) as [EntityId][];

  const patch: Record<string, Record<string, unknown>> = {};
  // Retract the old rows in the same transaction that writes the new ones. An
  // `sf` entity is exactly these four facts, so nulling them empties it, and it
  // stops matching the `kind` clause the tag subquery and `readSessionState` use.
  for (const [id] of existing) patch[id] = { kind: null, session: null, facet: null, value: null };

  let i = 0;
  for (const { facet, values } of spec) {
    if (!validators.facet(facet)) throw new Error(`unknown facet '${facet}'`);
    for (const value of values) {
      if (!validators.value(value)) throw new Error(`facet ${facet} value must be a string, got ${typeof value}`);
      patch[`#_f${i++}`] = { kind: "sf", session: { "#": sessionId }, facet, value };
    }
  }
  await transact(patch);
}

/** Create a search session (filter = everything, view=all). */
export async function createSession(
  workspaceId: EntityId,
  viewerPersonaId: EntityId,
  actor: string,
): Promise<SessionHandle> {
  const created = await createSchemaEntity(await sessionSchema(), {
    kind: "session",
    workspace: { "#": workspaceId },
    viewer: { "#": viewerPersonaId },
    actor,
    view: "all",
    tagActive: false,
  });
  if (!created.ok) throw new Error(`session rejected: ${created.error.message}`);
  const sessionId = created.entityId;
  // sid = self, the selector every board body inlines. A patch through the same
  // boundary, so the session cannot drift out of its schema after creation either.
  const sid = await patchSchemaEntity(await sessionSchema(), sessionId, { sid: sessionId });
  if (!sid.ok) throw new Error(`session sid rejected: ${sid.error.message}`);
  await writeFacets(sessionId, [
    { facet: "status", values: STATUS_DOMAIN },
    { facet: "priority", values: PRIORITY_DOMAIN },
  ]);
  return { sessionId, workspaceId };
}

/** Push the whole Filter into the session facts (+ view/actor/tagActive). */
export async function setFilter(h: SessionHandle, f: Filter, actor: string): Promise<void> {
  await writeFacets(h.sessionId, [
    { facet: "status", values: f.status.length ? f.status : STATUS_DOMAIN },
    { facet: "priority", values: f.priority.length ? f.priority : PRIORITY_DOMAIN },
    { facet: "tag", values: f.tags },
  ]);
  const r = await patchSchemaEntity(await sessionSchema(), h.sessionId, {
    view: f.view,
    group: f.group, // display-only, but per-session state, so it lives here too
    actor,
    tagActive: f.tags.length > 0,
    // Any filter change returns to page 1. Keeping the offset would leave a reader
    // on page 7 of a result that now has two pages, staring at an empty board that
    // is not empty.
    page: 0,
  });
  // `view` is an enum in the schema, so an unknown view is refused here rather
  // than silently producing a board that matches nothing.
  if (!r.ok) throw new Error(`filter rejected: ${r.error.message}`);
}

/** A session's `sf` rows, as (facet, value) pairs. */
const facetRows = (sessionId: EntityId) =>
  query({
    find: ["?facet", "?value"],
    where: [
      ["?f", "kind", "sf"],
      ["?f", "session", { "#": sessionId }],
      ["?f", "facet", "?facet"],
      ["?f", "value", "?value"],
    ],
  }) as Promise<[string, string][]>;

/**
 * Everything a render needs from a session, in one round of reads.
 *
 * This is the read the board is now BUILT from rather than merely rendered
 * alongside, so it is one function: the entity and its facet children, fetched in
 * parallel, turned into the Filter the query compiler takes. Asking for them
 * separately would read the session twice per paint.
 */
async function readSessionState(h: SessionHandle): Promise<{ filter: Filter; page: number }> {
  const [e, rows] = await Promise.all([readEntity(h.sessionId), facetRows(h.sessionId)]);
  const of = (facet: string) => rows.filter(([f]) => f === facet).map(([, v]) => v);
  // The encoding this has to invert: an empty facet is materialized as the whole
  // domain when it is written, so a full set reads back as "no filter". Picking
  // every value by hand is therefore indistinguishable from picking none, which is
  // exactly how the UI treats them anyway — and `inDomain` puts the domain back.
  const unDomain = (vals: string[], domain: readonly string[]) => (vals.length >= domain.length ? [] : vals);
  return {
    filter: {
      status: unDomain(of("status"), STATUS_DOMAIN) as Filter["status"],
      priority: unDomain(of("priority"), PRIORITY_DOMAIN) as Filter["priority"],
      tags: of("tag"),
      view: (e.view as Filter["view"]) ?? "all",
      group: (e.group as Filter["group"]) ?? "status",
    },
    page: Math.max(0, Math.trunc(Number(e.page ?? 0))),
  };
}

/**
 * The current board PAGE — a one-shot dry-run, so it always recomputes.
 *
 * Two reads: the session's own facts, then the rows. The first is what the second
 * is built from, which is the shape of this whole file — filters are facts, and a
 * read compiles them rather than joining them.
 *
 * There is no reactor here at all now, stored or ephemeral. Page 0 used to be a
 * provisioned reactor read with a `sid` bind and a deeper page an ephemeral one
 * created and deleted around the read (31-44ms + 21-38ms, and ~158 entity ids that
 * never come back). Neither survives a body that varies with the filter, and
 * neither is missed: a dry-run is what a stored reactor costs to read anyway
 * (measured: 27ms dry-run vs 29ms through the stored reactor, indexed), so the
 * reactor was buying nothing but a subscription this file no longer owns.
 */
export async function readSnapshot(h: SessionHandle): Promise<Snapshot> {
  const { filter, page } = await readSessionState(h);
  const rows = await query<SnapshotRow>(canonicalBody(boardQuery(h.sessionId, filter), pageWindow(page)));
  return paged(rows, page);
}

/** Cut the read-ahead row off a window and report it as `hasMore`. */
const paged = (rows: SnapshotRow[], page: number): Snapshot => ({
  rows: rows.slice(0, PAGE_SIZE),
  page,
  hasMore: rows.length > PAGE_SIZE,
});

/**
 * Move a session to page `n`.
 *
 * The page is per-session state, so it is a fact on the session like every filter —
 * two browsers on the same board are on their own pages and the server holds
 * nothing. Unlike a filter it is NOT read by anything that subscribes, so writing
 * it cannot re-emit; the caller re-renders (server.ts, `applyPage`).
 */
export async function setPage(h: SessionHandle, n: number): Promise<void> {
  const r = await patchSchemaEntity(await sessionSchema(), h.sessionId, { page: Math.max(0, Math.trunc(n)) });
  if (!r.ok) throw new Error(`page rejected: ${r.error.message}`);
}

/**
 * The Filter a session currently encodes, read back out of Stardust.
 *
 * The session IS the filter state, so the server holds none: two browsers on the
 * same board have two sessions and two independent filters. This is what the
 * filter bar renders from and what a filter toggle reads before writing — the same
 * facts `readSnapshot` compiles into the query, read the same way.
 */
export async function readFilter(h: SessionHandle): Promise<Filter> {
  return (await readSessionState(h)).filter;
}

/**
 * Point a session at a different workspace or viewer.
 *
 * The scope is facts ON the session, so switching workspace or "view as" has to
 * move the session too — otherwise the board keeps rendering the old scope.
 */
export async function retargetSession(
  h: SessionHandle,
  workspaceId: EntityId,
  viewerPersonaId: EntityId,
): Promise<void> {
  const r = await patchSchemaEntity(await sessionSchema(), h.sessionId, {
    workspace: { "#": workspaceId },
    viewer: { "#": viewerPersonaId },
  });
  if (!r.ok) throw new Error(`session retarget rejected: ${r.error.message}`);
}
