// A "search session" that lives in Stardust — the SINGLE source of truth.
//
// The filter state is facts (a `session` entity + `sf` facet child entities); ONE
// canonical reactor applies EVERY filter — priority, status(effective), tags, the
// derived views (ready/overdue/mine/done), and viewer visibility — entirely
// server-side, then projects the fully-shaped, fully-filtered board rows. Clients
// read that snapshot and render it; there is no app-side filtering layer. Each
// session reads the reactor via a per-stream bind (`?bind={sid …}`).
//
// The board no longer DERIVES anything per row. `blocked`, `effectiveStatus` and
// `prank` are stored facts, written by the transaction that causes them (todos.ts,
// `refreshDerived`), so this body JOINS them — `[?t effectiveStatus ?eff]` where it
// used to run a correlated `exists` and then a `cond` over the result. That is what
// phase 1 was for: a correlated subquery is executed once per candidate ROW against
// a budget of 10,000 executions shared by the ENTIRE query, so the three of them
// here did not degrade past a few thousand todos, they hard-failed — and `limit`
// cannot rescue it, being a post-filter that neither reduces executions nor raises
// the ceiling. Measured unindexed: the board refused outright at 5,000 and 10,000
// todos before this change, and answers both now.
//
// Ordering is `orderBy [?prank ?title ?t]`. `prank` is the priority ORDINAL
// (high 0, med 1, low 2), so ascending is high→med→low; the board used to order by
// the priority STRING, which is alphabetical nonsense (high, low, med). `?t` is the
// final tiebreaker — real titles are not unique, and only a total order keeps an
// offset from dropping and repeating rows.
//
// TWO clauses stay expensive, and each is compiled OUT of the body when it is not
// needed: `canonicalBody(shape)`, one provisioned reactor per shape.
//
//   * The TAG filter is the one surviving correlated `exists`, so it keeps a
//     ceiling of its own — "however many rows reach it", measured at about 10,000.
//     It cannot become a plain join: a todo carrying two selected labels would come
//     back twice (the harness caught exactly that). So it stays a bound `exists`, it
//     sits LAST where the fewest rows reach it, and a session with no tag selected
//     does not carry it at all.
//   * `overdue` compares against WALL-CLOCK time, so no write can ever be the
//     moment it changes and it cannot be a stored fact. It is plain clauses
//     (`[?t due ?due] [< ?due ?now]`) in the `overdue` shape, with `now` supplied as
//     a per-read BIND. It used to be a correlated `exists` holding a literal
//     `{#utc 2026-07-11…}` baked in when the reactor was provisioned — which went
//     quietly WRONG the moment the wall clock passed it, and had been wrong for
//     weeks. A bind is stale for the life of one subscription instead of forever.
//
// The board returns ONE PAGE, not every matching row: `limit`/`offset` on the body,
// fifty rows shown and a fifty-first read to know whether there is a next page.
// Be precise about what that buys, because the obvious claim is wrong. `limit` is a
// POST-FILTER: at 2,000 unindexed todos the plain body costs 7.6s unlimited, 7.5s
// with `limit 50`, and 7.5s with `limit 50 offset 1000`, and a bare `find[[count
// ?t]]` over the identical `where` costs the same 7.5s. Removing the correlated
// subqueries in phase 1 did not turn `limit` into an early exit — the engine still
// evaluates every clause and then throws rows away. So paging bounds the RESPONSE,
// the render and the memory a result set occupies; it does not bound the query. The
// query's cost is still the corpus, and that is the next thing to be honest about,
// not something this change fixed.
//
// `limit` and `offset` are body fields and refuse a bind (`limit must be number`),
// so one stored reactor cannot serve every page. Page 0 IS the stored reactor — it
// is what every session opens on and the only page with a live subscription — and a
// deeper page is an ephemeral reactor created for that read and deleted after it.
//
// Todos are a point-in-time SNAPSHOT: a one-shot read always recomputes, and the
// live stream re-emits whenever the RESULT changes. There is no revision counter
// and no explicit refresh: the facet rows and the session's scalars are top-level
// clauses, so writing them invalidates on their own. Measured against Stardust
// directly — retracting a status facet with no other write pushed 7 rows -> 3, and
// putting it back pushed 3 -> 7, while a bump of a counter field pushed nothing at
// all because the result had not changed.
//
// What shaping the body per session costs: a filter change can move a session onto
// a DIFFERENT reactor, and an open subscription cannot follow it. The server drops
// and re-opens the stream when the shape changes (server.ts, `applyFilter`). That is
// the price of not carrying two subqueries that are dead most of the time.

import {
  type Bind,
  type EntityId,
  createReactor,
  createSchemaEntity,
  deleteReactor,
  patchSchemaEntity,
  query,
  readEntity,
  readResults,
  streamResults,
  transact,
} from "./stardust.ts";
import { sessionSchema } from "./schemas.ts";
import { validators } from "./field-registry.ts";
import { ensureReactor } from "./reactors.ts";
import type { Filter } from "./board.ts";
import { APP } from "./tenancy.ts";

// The status facet filters on the STORED `effectiveStatus`, so "blocked" is one of
// its values. Priorities as stored. Empty facet = "all" (materialized — an absent
// join matches nothing).
const STATUS_DOMAIN = ["todo", "doing", "blocked", "done"] as const;
const PRIORITY_DOMAIN = ["low", "med", "high"] as const;

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
 * `query: limit must be number`, and so is `offset ?off` and `{#bind off}`. So a
 * window is part of the query TEXT, and one stored reactor cannot serve every page.
 * See `boardTarget` for what this app does about that.
 */
export interface PageWindow {
  limit: number;
  offset: number;
}

/** The window a page index reads: one more row than it shows, to detect a next page. */
export const pageWindow = (page: number): PageWindow => ({ limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE });

/** One board row as the reactor projects it. Reachable as `Snapshot["rows"][number]`
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
 * Which expensive clauses a board body carries.
 *
 * Both are false for the common case and both cost a real ceiling when true, so the
 * body is compiled per shape and each shape is provisioned as its own named reactor
 * rather than every session paying for clauses it does not use.
 */
export interface BoardShape {
  /** the session has ≥1 tag selected — adds the one remaining correlated `exists` */
  tag: boolean;
  /** view=overdue — adds the wall-clock `due < ?now` clauses, and needs a `now` bind */
  overdue: boolean;
}

/** The plain body: no subqueries at all. */
export const PLAIN_SHAPE: BoardShape = { tag: false, overdue: false };

/** The shape a Filter needs. The session's own facts say the same thing; this is the
 *  app-side form, for a caller that is already holding the filter. */
export const boardShape = (f: Pick<Filter, "tags" | "view">): BoardShape => ({
  tag: f.tags.length > 0,
  overdue: f.view === "overdue",
});

/** Two shapes are the same subscription target iff they name the same reactor. */
export const boardShapeKey = (s: BoardShape): string => `${s.overdue}|${s.tag}`;

/** Every board body this app provisions (`npm run stardust:setup`). */
export const BOARD_SHAPES: readonly BoardShape[] = [
  PLAIN_SHAPE,
  { tag: true, overdue: false },
  { tag: false, overdue: true },
  { tag: true, overdue: true },
];

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

// The canonical board reactor. A session is selected by its `sid` (bind); its scalar
// fields (viewer/view/actor/tagActive/workspace) drive the filters, and its `sf`
// facet entities drive the multi-select value-joins. Every one of those is a
// top-level clause, so writing any of them re-emits — no revision counter needed.
// Projects the fully-filtered, fully-shaped board rows.
//
// `shape` decides which of the two expensive clause groups the body carries; see the
// file header. The plain body executes ZERO subqueries, which is what lets it answer
// at 10,000 todos at all.
// `window` is a REQUIRED argument with no default, and that is deliberate. A body
// silently defaulting to "every matching row" is the shape of bug this phase exists
// to prevent, and a body silently defaulting to page 0 would make an oracle that
// compares against the whole corpus quietly compare against fifty rows. Passing
// `null` means "no window" and has to be typed out.
export function canonicalBody(shape: BoardShape, window: PageWindow | null): Record<string, unknown> {
  return {
    enabled: true,
    find: ["?t"],
    where: [
      ["?sess", "kind", "session"],
      ["?sess", "sid", "?sid"], // ?sid supplied per-stream via ?bind
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
      // priority filter (value-join)
      ["?fp", "kind", "sf"],
      ["?fp", "session", "?sess"],
      ["?fp", "facet", "priority"],
      ["?fp", "value", "?priority"],
      // status filter (value-join on the STORED effective status)
      ["?fs", "kind", "sf"],
      ["?fs", "session", "?sess"],
      ["?fs", "facet", "status"],
      ["?fs", "value", "?eff"],
      // derived-view filter (single-select), all over BOUND vars.
      //
      // `overdue` is not one of them: it needs `?due` bound by a fact clause, and a
      // fact clause cannot be conditional — joining `due` would silently drop every
      // todo that has no due date. So the overdue shape REPLACES the `or` with the
      // plain clauses plus a guard, and every other view keeps the `or` without an
      // overdue branch. Reading the wrong shape therefore returns NOTHING rather
      // than something wrong.
      ...(shape.overdue
        ? [
            ["=", "?view", "overdue"],
            ["?t", "due", "?due"],
            ["<", "?due", "?now"], // ?now supplied per read — wall clock is not a fact
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
      // Tag filter, LAST: the one correlated `exists` left, so it runs against the
      // smallest row set the rest of the body can hand it. `tagActive` is read here
      // too, which keeps this body correct (if not cheap) when the last tag chip is
      // deselected — so clearing the filter cannot flash an empty board while the
      // stream is moving back to the plain shape.
      ...(shape.tag
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

/** The name of the PLAIN board body — and the prefix the others extend. It stays
 *  `board` so the x-ray card and its "copy as RON" keep naming the one people read. */
const BOARD_REACTOR = "board";

/** The provisioned name for a shape: `board`, `board-tag`, `board-overdue`, … */
export const boardReactorName = (s: BoardShape): string =>
  `${BOARD_REACTOR}${s.overdue ? "-overdue" : ""}${s.tag ? "-tag" : ""}`;

const reactorIds = new Map<string, Promise<EntityId>>();
/**
 * The board reactor for `shape`, provisioned under its name. Idempotent — it
 * creates the reactor, updates it if `canonicalBody(shape)` has changed since, or
 * does nothing. Memoized per shape, so the check costs one round trip per process
 * rather than one per read.
 */
export function ensureBoardReactor(shape: BoardShape = PLAIN_SHAPE): Promise<EntityId> {
  const name = boardReactorName(shape);
  let pending = reactorIds.get(name);
  if (!pending) {
    // The PROVISIONED bodies are the first page. Page 0 is where every session
    // starts, where the live subscription lives, and where the demo spends all of
    // its time — so it is the page that must not pay for a reactor of its own.
    pending = ensureReactor(name, canonicalBody(shape, pageWindow(0))).then((r) => r.id);
    reactorIds.set(name, pending);
  }
  return pending;
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
 * enum that matters (`view`) lives.
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
  // stops matching the reactor's `kind` clause.
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

/** Create a search session (filter = everything, view=all) + ensure the reactor. */
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
  // sid = self, the bind selector. A patch through the same boundary, so the
  // session cannot drift out of its schema after creation either.
  const sid = await patchSchemaEntity(await sessionSchema(), sessionId, { sid: sessionId });
  if (!sid.ok) throw new Error(`session sid rejected: ${sid.error.message}`);
  await writeFacets(sessionId, [
    { facet: "status", values: STATUS_DOMAIN },
    { facet: "priority", values: PRIORITY_DOMAIN },
  ]);
  await ensureBoardReactor();
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

/**
 * The reactor and the binds this session's board needs right now.
 *
 * The shape is a function of the session's OWN facts, so it is read from Stardust
 * rather than passed in — the session is the source of truth for its filter, and a
 * caller that guessed wrong would read a body that does not model its question.
 * `now` rides along for the overdue shape: wall-clock time cannot be a stored fact,
 * so the only honest place for it is the read.
 */
async function boardTarget(h: SessionHandle): Promise<{ rid: EntityId; bind: Bind; page: number; owned: boolean }> {
  const e = await readEntity(h.sessionId);
  const shape: BoardShape = { tag: e.tagActive === true, overdue: e.view === "overdue" };
  const bind: Bind = { sid: h.sessionId };
  if (shape.overdue) bind.now = { "#utc": new Date().toISOString() };
  const page = Math.max(0, Math.trunc(Number(e.page ?? 0)));
  // Page 0 is the provisioned reactor. A deeper page is a body Stardust has never
  // been asked before, and it cannot be reached by parameterising the stored one:
  // `limit`/`offset` refuse a bind. So it is created for this read and destroyed
  // after it — `owned` says which of the two the caller is holding.
  //
  // The trade, measured on the box this runs on (2,000 unindexed todos): creating a
  // window reactor is 31–44ms and deleting it 21–38ms, against a board read of
  // 7.6s. Sixty-five milliseconds is under 1% there — but on the DEMO database the
  // same board read is 27ms indexed, where it would be a 3x slowdown on every
  // paint. That asymmetry is the whole argument for the split: the page everyone
  // is on is stored, and only a deliberate navigation pays for a reactor.
  //
  // It costs entity IDS as well as time, and more than the reactors.ts note
  // suggests: consecutive board reactors came back 158 ids apart, because every
  // clause of this body is an entity too. Deleting the reactor does not give them
  // back. That is affordable for a page click and would not be for a per-render
  // reactor, which is the other half of why page 0 is provisioned once.
  if (page === 0) return { rid: await ensureBoardReactor(shape), bind, page, owned: false };
  // `enabled: false`, unlike the provisioned ones. An enabled reactor is a standing
  // subscription the engine maintains, and this one exists for a single bound read
  // — leaving it enabled asks the engine to evaluate the body with NO bind, which
  // for the overdue shape is not merely wasted work but a query that cannot answer
  // (`unbound input var ?now`). A disabled reactor still answers `/results`.
  const body = { ...canonicalBody(shape, pageWindow(page)), enabled: false };
  return { rid: await createReactor(body), bind, page, owned: true };
}

/**
 * The current board PAGE — a one-shot read (always recomputes).
 *
 * The board no longer returns every matching row. It asks for `PAGE_SIZE + 1` and
 * returns at most `PAGE_SIZE`, with the extra row spent on `hasMore` rather than
 * shown. Note what `limit` does NOT buy: measured at 2,000 unindexed todos, the
 * board costs 7.6s unlimited, 7.5s with `limit 50`, and 7.5s with `limit 50 offset
 * 1000` — `limit` is a POST-FILTER, and removing every subquery from the body did
 * not change that. What paging bounds is the response, the render and the memory
 * the result set occupies, not the query.
 */
export async function readSnapshot(h: SessionHandle): Promise<Snapshot> {
  const { rid, bind, page, owned } = await boardTarget(h);
  try {
    return paged(((await readResults(rid, bind)) as SnapshotRow[]) ?? [], page);
  } finally {
    if (owned) await deleteReactor(rid).catch((e) => console.error("page reactor:", e));
  }
}

/** Cut the read-ahead row off a window and report it as `hasMore`. */
const paged = (rows: SnapshotRow[], page: number): Snapshot => ({
  rows: rows.slice(0, PAGE_SIZE),
  page,
  hasMore: rows.length > PAGE_SIZE,
});

/**
 * Watch this session's board. Stardust pushes the complete new result whenever the
 * result CHANGES — a filter write, a scope change, or a todo field in the top-level
 * `where` — so the server does not have to notice anything itself. An emission means
 * the rows differ; writing a field without changing the result pushes nothing.
 *
 * TOP-LEVEL clauses are the reliable trigger, and they cover rows that did not
 * exist when the stream opened: a brand-new entity the top-level clauses match
 * invalidates too, and only for the binds it actually matches (measured on the
 * `command-menu` reactor — see AGENTS.md, "What a subscription pushes").
 *
 * The one measured gap is TAG edges. Adding a tag pushes nothing — verified from a
 * background script and again with the tag filter active, so even an edge that
 * changes which rows match is invisible here. DEP edges do push (measured twice),
 * as do todo field writes from anywhere including the CLI, so this is narrower than
 * "subqueries don't invalidate": it is specifically the tag path. Treat the board as
 * a snapshot that advances on its own filter writes, on field writes, and on
 * dependency changes.
 *
 * A second gap arrives with the shaped body: this subscription is pinned to ONE
 * reactor, and a filter change can move the session to another. The caller has to
 * drop and re-open when `boardShape` changes — server.ts does, in `applyFilter`.
 * The `now` bind is likewise fixed for the life of the subscription, so an overdue
 * board that stays open past midnight is stale until something re-opens it.
 */
export async function watchSnapshot(
  h: SessionHandle,
  onPage: (snap: Snapshot) => void,
  signal: AbortSignal,
): Promise<void> {
  const { rid, bind, page, owned } = await boardTarget(h);
  if (!owned) {
    await streamResults(rid, (rows) => onPage(paged(rows as SnapshotRow[], page)), signal, bind);
    return;
  }
  // A page past the first is NOT live, and this is where that is decided rather
  // than hidden. Subscribing would mean holding an ephemeral reactor open for as
  // long as a browser sits on page 7 — durable state whose lifetime is a scroll
  // position, and a leak the moment the process dies with the tab still open.
  // Deep pages are a snapshot: painted once, then still until the reader navigates.
  // Making them live is what the page-set subscription is for; it is not this
  // change, and pretending otherwise would be worse than saying so.
  try {
    onPage(paged(((await readResults(rid, bind)) as SnapshotRow[]) ?? [], page));
  } finally {
    await deleteReactor(rid).catch((e) => console.error("page reactor:", e));
  }
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Move a session to page `n`.
 *
 * The page is per-session state, so it is a fact on the session like every filter —
 * two browsers on the same board are on their own pages and the server holds
 * nothing. Unlike a filter it is NOT read by the board's `where` (an offset is body
 * text, not a clause), so writing it cannot re-emit; the caller re-renders, and
 * server.ts drops and re-opens the stream exactly as it does for a shape change.
 */
export async function setPage(h: SessionHandle, n: number): Promise<void> {
  const r = await patchSchemaEntity(await sessionSchema(), h.sessionId, { page: Math.max(0, Math.trunc(n)) });
  if (!r.ok) throw new Error(`page rejected: ${r.error.message}`);
}

/** The page a session is on. */
export async function readPage(h: SessionHandle): Promise<number> {
  return Math.max(0, Math.trunc(Number((await readEntity(h.sessionId)).page ?? 0)));
}

/**
 * The Filter a session currently encodes, read back out of Stardust.
 *
 * The session IS the filter state, so the server holds none: two browsers on the
 * same board have two sessions and two independent filters. Note the encoding
 * this has to invert — an empty facet is materialized as the whole domain (an
 * absent join matches nothing), so a full set reads back as "no filter". Picking
 * every value by hand is therefore indistinguishable from picking none, which is
 * exactly how the UI treats them anyway.
 */
export async function readFilter(h: SessionHandle): Promise<Filter> {
  const [e, rows] = await Promise.all([
    readEntity(h.sessionId),
    query({
      find: ["?facet", "?value"],
      where: [
        ["?f", "kind", "sf"],
        ["?f", "session", { "#": h.sessionId }],
        ["?f", "facet", "?facet"],
        ["?f", "value", "?value"],
      ],
    }) as Promise<[string, string][]>,
  ]);
  const of = (facet: string) => rows.filter(([f]) => f === facet).map(([, v]) => v);
  const unDomain = (vals: string[], domain: readonly string[]) => (vals.length >= domain.length ? [] : vals);
  return {
    status: unDomain(of("status"), STATUS_DOMAIN) as Filter["status"],
    priority: unDomain(of("priority"), PRIORITY_DOMAIN) as Filter["priority"],
    tags: of("tag"),
    view: (e.view as Filter["view"]) ?? "all",
    group: (e.group as Filter["group"]) ?? "status",
  };
}

/**
 * Point a session at a different workspace or viewer.
 *
 * The scope is facts ON the session, so switching workspace or "view as" has to
 * move the session too — otherwise the board keeps rendering the old scope. Both
 * fields are top-level clauses in the reactor, so the write re-emits by itself.
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
