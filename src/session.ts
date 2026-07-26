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
  createSchemaEntity,
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

export interface SnapshotRow {
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
export function canonicalBody(shape: BoardShape = PLAIN_SHAPE): Record<string, unknown> {
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
    pending = ensureReactor(name, canonicalBody(shape)).then((r) => r.id);
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
async function boardTarget(h: SessionHandle): Promise<{ rid: EntityId; bind: Bind }> {
  const e = await readEntity(h.sessionId);
  const shape: BoardShape = { tag: e.tagActive === true, overdue: e.view === "overdue" };
  const bind: Bind = { sid: h.sessionId };
  if (shape.overdue) bind.now = { "#utc": new Date().toISOString() };
  return { rid: await ensureBoardReactor(shape), bind };
}

/** The current fully-filtered board snapshot — a one-shot read (always recomputes). */
export async function readSnapshot(h: SessionHandle): Promise<SnapshotRow[]> {
  const { rid, bind } = await boardTarget(h);
  return (await readResults(rid, bind)) as SnapshotRow[];
}

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
  onRows: (rows: SnapshotRow[]) => void,
  signal: AbortSignal,
): Promise<void> {
  const { rid, bind } = await boardTarget(h);
  await streamResults(rid, (rows) => onRows(rows as SnapshotRow[]), signal, bind);
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
