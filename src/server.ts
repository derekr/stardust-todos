// Datastar web UI: workspace-aware, with Linear-style filtering/grouping/
// aggregates (all powered by Stardust queries) and a dependency action menu.
//
// The board is per URL. `/?st=todo&v=ready&p=2` IS the filter — decoded, domain-
// checked and compiled into the query on every read — so this process holds no
// per-user filter state and two readers of one link get two independent views.
// Live updates are Stardust subscriptions: `page-rows` bound to the fifty rows an
// open stream is showing, and `GET /entities/{id}` for the detail pane. Not app
// code watching for changes.
//
// What that replaced is worth naming, because it was the app's headline claim: the
// filter used to be FACTS on a per-browser `session` entity, and `/` minted one and
// redirected to `/s/<sid>`. filter.ts carries the three measurements that retired
// it. The one this file is the evidence for is that a filter write re-emitted
// NOTHING — `session-page` never had an `sf` clause — so `remount()` here aborted
// the SSE stream and re-opened it by hand on every click. A filter change is a new
// URL now, so it is a new stream, and the client re-opening it is the whole
// mechanism.
//
//   node src/server.ts        # http://localhost:3000

import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/node";
import {
  type Priority,
  type Status,
  type Todo,
  addTodo,
  backfillActor,
  ensureDemoDrafts,
  migrateBlockedStatus,
  migrateDerivedFields,
  migrateVisibilityFields,
  publishTodo,
  removeTodo,
  setPriority,
  setStatus,
  toggleTodo,
} from "./todos.ts";
import { type WorkspaceCtx, defaultWorkspace, openWorkspace } from "./workspace.ts";
import { lookupRef } from "./registry.ts";
import { createPersona, createWorkspace, ensureUser, grantAccess, listPersonas, roleOf } from "./tenancy.ts";
import { authorizeCommand, ensureCommandCatalog, visibleCommands } from "./commands.ts";
import { addDependency, removeDependency, tagsOf } from "./features.ts";
import { migrateTagComponents } from "./tags.ts";
import {
  SEARCH_LIMIT,
  availableTags,
  blockersFor,
  blockersOf,
  effectiveStatus,
  searchTodoOptions,
  todoOptions,
} from "./board.ts";
import { type Counts, type CountsHold, holdCounts, liveCountScopes } from "./counts.ts";
import { type BoardScope, boardQuery, readSnapshot } from "./board-query.ts";
import { type BoardState, FilterError, decodeFilter } from "./filter.ts";
import { BASE, TxConflictError, lastTx, readEntity, readReactorRon, watchEntity } from "./stardust.ts";
import { DECLARED, PICKER_LIMIT, blockedByTodo, boardCounts, pageRows } from "./queries.ts";
import {
  type PageSet,
  frameKey,
  leasePageSet,
  pooledPageSets,
  recoverPool,
  releasePageSet,
  showPage,
  watchPage,
} from "./pageset.ts";
import { statusHistory } from "./history.ts";
import {
  type BoardView,
  boardEl,
  boardFragment,
  filterBar,
  filterBarEl,
  page,
  palette,
  sidebar,
  visibleLabel,
} from "./view.ts";
import { type DetailOpts, type HistEntry, candidateList, detailFragment, detailPage } from "./detail.ts";
import {
  type TxView,
  collectReplay,
  feedList,
  inspectPage,
  provenance,
  provenancePanel,
  replayView,
  scrubber,
  streamTxFeed,
  timingTable,
} from "./inspect.ts";
import { Trace, debugComment, recentRequests } from "./timing.ts";

/** Reactors the x-ray may hand out as RON: exactly the ones it documents. */
/**
 * Bind values for a reactor's free vars, so a copied body RUNS as pasted.
 *
 * A query body carries its own `bind {…}` clause — the same mechanism as the
 * `?bind=` query param, expressed in the document — so the body itself is left
 * byte-identical to what is stored and the bind sits on top, visible and editable
 * in the lab. That matters: the point of pasting into a playground is to change
 * the input, and a substituted literal is no longer a parameter.
 *
 * Without one, a free var in a fact clause matches everything: the board pasted
 * bare returns every todo once per SESSION (208 rows against 8), which is how this
 * was found.
 *
 * `ps` and `todo` come from the page the x-ray was opened on, so what you paste is
 * scoped to what you were looking at; the rest come from the current workspace.
 */
function runnableBinds(name: string, from: { ps?: string; todo?: string }): Record<string, string> {
  const ws = `{# ${ctx.workspaceId}}`;
  const viewer = `{# ${ctx.personaId}}`;
  switch (name) {
    // The board's live subscription. It is bound by the page-set, so pasting it
    // bare returns every open stream's page at once — the same trap the board
    // reactor had. (The board's ROW query is not here: it is a dry-run whose body
    // is built per read with no free vars at all, so there is nothing to bind.)
    case "page-rows":
      return from.ps ? { ps: `{# ${from.ps}}` } : {};
    case "todo-options":
      return { ws, viewer };
    case "board-tags":
      return { ws };
    // The chips' tally, held open by counts.ts. Pasted bare it counts every
    // workspace at once and every draft in all of them — the same trap as above,
    // and the reason a viewer is half of what makes this answer correct.
    case "board-counts":
      return { ws, viewer };
    case "todo-tags":
    case "todo-blocks":
      return from.todo ? { todo: `{# ${from.todo}}` } : {};
    case "command-menu":
      return { scope: "'global'", rank: "2" };
    case "command-authz":
      return { cmdId: "'workspace.archive'", rank: "2" };
    default:
      return {};
  }
}

/** Prepend the body's own `bind {…}` clause. Values are already RON literals. */
function withBindClause(body: string, binds: Record<string, string>): string {
  const pairs = Object.entries(binds);
  if (!pairs.length) return body;
  return `bind {${pairs.map(([k, v]) => `${k} ${v}`).join(" ")}}\n${body}`;
}

const RON_EXPORTABLE = new Set<string>(DECLARED.map((d) => d.name));

const PORT = Number(process.env.PORT ?? 3000);

let ctx: WorkspaceCtx = await defaultWorkspace();

// Demo roles: the default persona owns the workspace; add a "Teammate" persona
// with a member grant so "view as" can switch role and drive the command
// projection. Commands themselves are seeded as data.
await ensureCommandCatalog();
await backfillActor(); // give pre-existing todos a lastActor so the board projection is complete
await migrateBlockedStatus(); // blocked-ness is derived now — revert any legacy stored "blocked" rows
await migrateVisibilityFields(ctx.personaId); // give legacy todos author + draft:false so visibility binds
// v4: blocked/effectiveStatus/prank are STORED now, written by the transaction
// that causes them. Todos written before that change carry none, and a reader that
// matches on a field a row has never been written skips the row silently rather
// than erroring — so the backfill is what keeps the change invisible. Idempotent:
// it computes the answer and writes only the rows that differ, so a second boot
// writes nothing.
await migrateDerivedFields();
// The tag component the board's filter matches on. Todos whose tag EDGES predate it
// carry none, and a row that has never been written a field a clause names is
// skipped in silence — which for a tag filter means a todo that simply stops being
// findable by its own label. Idempotent the same way: it writes exactly what
// `reconcileTags` reports diverging, so a second boot writes nothing.
await migrateTagComponents();
const OWNER_PERSONA = ctx.personaId;
const demoUser = await ensureUser("default@local");
if (!(await listPersonas(demoUser)).some((p) => p.name === "Teammate")) {
  const mid = await createPersona(demoUser, "Teammate");
  await grantAccess(ctx.workspaceId, mid, "member");
}
const MEMBER_PERSONA = (await listPersonas(demoUser)).find((p) => p.name === "Teammate")!.id;
await ensureDemoDrafts(ctx, OWNER_PERSONA, MEMBER_PERSONA); // a draft per persona → "view as" visibly differs
const personaId = ctx.personaId; // owner — used for wsbar + workspace ops
let viewPersona = OWNER_PERSONA; // "view as" — drives command projection + enforcement
const curRole = () => roleOf(viewPersona, ctx.workspaceId);
const actorName = () => (viewPersona === MEMBER_PERSONA ? "Teammate" : "Owner"); // stamped on writes

// A long-running server hosts many long-lived streams; a stray rejection from
// any of them must never take the process down. Log and keep serving.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

// Still no durable-workflow worker, and now for a sharper reason than "nothing is
// materialized". `blocked` IS materialized again — but by the request that causes
// it, inside the same write path, not by a process watching for work to do. A
// worker would be a second writer racing the first; the choke point (todos.ts,
// patchTodo/refreshDerived) is one writer that already knows what changed.

/** The half of the board's inputs a client does not get to supply. */
const scopeNow = (): BoardScope => ({ workspace: ctx.workspaceId, viewer: viewPersona, actor: actorName() });

/** `?debug=1` — hand this request's own timing record back in the response. */
const debug = (parsed: URL): boolean => parsed.searchParams.get("debug") === "1";

const noopStream = (req: http.IncomingMessage, res: http.ServerResponse) =>
  ServerSentEventGenerator.stream(req, res, () => {});

// Glass-box inspector state. The live feed keeps a small shared ring buffer;
// replay caches the last full log read so scrubbing doesn't re-replay each step.
const feedBuf: TxView[] = [];
let replayCache: TxView[] | null = null;
// Datastar sends signals on GET as a `?datastar=<json>` query param.
const getSignals = (req: http.IncomingMessage): Record<string, unknown> => {
  try {
    const d = new URL(req.url ?? "", "http://x").searchParams.get("datastar");
    return d ? JSON.parse(d) : {};
  } catch {
    return {};
  }
};

// ---- Open board streams ------------------------------------------------------
//
// The only per-stream state this process keeps, and it is not filter state: a
// repaint hook, so a change to something the URL does NOT carry can still reach an
// open board. There are exactly two of those — the active workspace and the "view
// as" persona — and both are genuinely server-side (one workspace per server is a
// demo simplification, and the viewer decides which drafts exist at all).
//
// A filter or page change does not come through here. It is a different URL, so it
// is a different document and a different stream, and the old one is closed by the
// browser. That is what `remount()` + `boardGate` used to do by hand: abort the
// subscription, wait for the filter facts to land, re-subscribe. The subscription
// (`page-rows`) watches the rows ON the page, so it was never going to fire for a
// write that changes which rows BELONG on it.
const openBoards = new Set<{ repaint: () => void }>();
const repaintAll = () => {
  for (const b of openBoards) b.repaint();
};

// ---- Vendored static assets ------------------------------------------------
// `public/` is populated by scripts/vendor-assets.sh. Names are content-pinned
// (a version or a font hash), so they can be cached hard.
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

async function serveStatic(parts: string[], res: http.ServerResponse): Promise<void> {
  // Resolve inside PUBLIC_DIR and verify — never trust the URL to stay put.
  const file = path.resolve(PUBLIC_DIR, parts.join("/"));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

// Everything the board renders from. The todo list is the session snapshot — one
// query applies EVERY filter (priority, status, tags, views) + visibility +
// derivation server-side, so there is ONE read path feeding both the SSE patches
// and the server-rendered first paint.
//
// NOTE what paging does and does not bound here, because it is most of the answer
// to "why is a page view still O(workspace)". Three of the four reads it used to be
// true of are gone from the critical path: `blockersFor` asks about the rows on the
// page (it was every dependency edge in the workspace), the tag vocabulary is read
// once per STREAM rather than once per paint, and the TALLY is no longer waited for
// at all — see `renderBoard`. What is left is the rows, which are one page.
//
// The blocker read cannot join the snapshot's `Promise.all`, because it takes the
// ids the snapshot returned. It costs nothing when no row on the page is blocked,
// which is the common case — the query is not issued at all.
//
// Every read here goes through `t.read`, which will not time anything that cannot
// say how many rows it produced (src/timing.ts). The `rows` count on the SNAPSHOT
// is the rows the query returned, which is 51 on a page with a next one — the
// 51st is never rendered but it was read, and the number in the log is what the
// engine did rather than what the template used.
async function boardData(t: Trace, state: BoardState, pgset: PageSet | null, tags: string[]) {
  const snap = await t.read(
    "rows",
    () => readSnapshot(boardQuery(scopeNow(), state.filter), state.page),
    (s) => s.rows.length + (s.hasMore ? 1 : 0),
  );
  const todos = snap.rows as unknown as Todo[]; // SnapshotRow is Todo-shaped
  // Only the rows that will actually draw a ⊘ need their blockers, and `row()` draws
  // one exactly when the effective status is `blocked` — the same stored fact the
  // snapshot carries. So this asks about those rows and no others.
  //
  // `in` is what makes that legible afterwards: this read costs ~0ms both when no
  // row on the page is blocked (no query is issued at all) and when the query runs
  // and finds nothing, and those mean different things. `in 0` is the first.
  const blockedIds = todos.filter((x) => effectiveStatus(x) === "blocked").map((x) => x.id);
  const blockers = await t.read(
    "blockers",
    () => blockersFor(blockedIds),
    (m) => [...m.values()].reduce((n, bs) => n + bs.length, 0),
    blockedIds.length,
  );
  // Record what this stream is now looking at, so the page subscription follows it.
  // Costs nothing at all when the rows have not moved: `showPage` diffs against
  // what this process last wrote to those slots and sends no transaction — which is
  // exactly what `rows 0` means on this line, and why it is worth logging.
  if (pgset !== null) {
    const ids = snap.rows.map((r) => r.id);
    await t.read(
      "pgset",
      () => showPage(pgset, ids),
      (w) => (w ? w.asserted + w.retracted : 0),
      ids.length,
    );
  }
  return { snap, todos, tags, blockers };
}

// Render the filter bar + board over the stream, for ONE open board. The filter
// arrives with the stream's own URL and does not change for its lifetime — a
// different filter is a different stream — so it is captured once and passed down.
//
// So is the tag VOCABULARY, and for the same reason rather than as a saving. It is
// the tag filter's DOMAIN: `boardStateOf` read it to decide whether this stream's
// URL was one this workspace could answer, and re-reading it per paint would mean
// drawing chips from one vocabulary while the filter had been validated against
// another. It used to be read twice on the first paint and once per repaint (28ms
// each at 10,003 todos, over ten labels), which is what made it worth looking at.
//
// THE TALLY IS NOT READ AT ALL. It is held in memory by a subscription this stream
// has a hold on (counts.ts), so a paint takes the current value out of a field and
// issues no query — which is why `counts`, which used to be ~240ms of every record
// in the log, is not in any of them. What a paint can find there is `null`: the
// first stream on a (workspace, viewer) nothing is subscribed to yet paints the
// chips WITHOUT numbers, exactly as the SSR pass already does, and the
// subscription's first emission patches them a moment later through `chips`. That
// is the same trade the tally already made when it came off the critical path, and
// it is unchanged for a reader — the board arrives complete and three numerals
// follow. Nothing about the number can be narrowed: the chips answer "how many are
// there", and a page of fifty cannot say.
//
// What is new is that they stay right. A paint used to be the only thing that could
// move them, so a write to a todo NOT on this page left the chips stale until
// something else happened; the emission now patches them on its own, with no read
// behind it.
//
// `at()` is called per paint rather than once per stream because a REPAINT can move
// this stream to a different viewer ("view as") or workspace, and the tally is
// scoped to both — a hold acquired once would go on showing the previous persona's
// numbers.
//
// `why` says what provoked this paint — `open` for the one every stream starts
// with, `push` for one the page subscription woke, `repaint` for a workspace or
// "view as" switch. It is the field that answers a question nobody could ask
// before: a filter change repaints over a NEW stream, so it should produce exactly
// one `open` record, and three of them would mean three reads of the board where a
// reader saw one page.
async function renderBoard(
  stream: any,
  state: BoardState,
  pgset: PageSet,
  tags: string[],
  holder: CountsHold,
  why: string,
): Promise<string> {
  const t = new Trace("board-paint", why);
  t.describe(shapeOf(state, tags));
  // Captured before the rows, not re-read after them: if a push lands in between it
  // patches the chips itself, so this paint is about the numbers it started with.
  const counts = holder.at(ctx.workspaceId, viewPersona).now;
  const { snap, todos, blockers } = await boardData(t, state, pgset, tags);
  stream.patchElements(
    t.render(() => boardFragment(todos, blockers, state.filter, { state, hasMore: snap.hasMore }, pgset.id)),
  );
  stream.patchElements(t.render(() => filterBar(state, counts, tags)));
  stream.patchElements(t.render(() => sidebar(state, counts))); // desktop rail (hidden < 900px)
  t.done();
  // The emission this render's own page-set write is about to provoke, described in
  // the subscription's own terms. Returning it is what lets the stream loop drop the
  // echo instead of reading the whole board a second time to discover it changed
  // nothing.
  return frameKey(snap.rows);
}

// The same board, rendered into the initial HTML so the first paint is the real
// page. Datastar morphs its first patch over identical markup, so this is purely
// additive — nothing downstream changes.
//
// It renders the chips with NO numbers, which is what makes a filter change feel
// like one: this is the response a browser blocks on, and it is 75ms rather than
// 200ms without the tally in it. The numbers arrive on the stream this document
// opens a few milliseconds later, from the one read that computes them — so a page
// view now counts the workspace ONCE, where the SSR pass and the stream used to do
// it separately.
//
// No page-set: the SSR pass has no subscription to point at one. The stream that
// the document opens a moment later leases its own and writes it.
async function boardView(t: Trace, state: BoardState, tags: string[]): Promise<BoardView> {
  const { snap, todos, blockers } = await boardData(t, state, null, tags);
  return t.render(() => ({
    sidebar: sidebar(state, null),
    filterbar: filterBarEl(state, null, tags),
    board: boardEl(todos, blockers, state.filter, { state, hasMore: snap.hasMore }),
    visible: visibleLabel(todos.length, snap.hasMore),
  }));
}

/**
 * The filter, as a log line describes it.
 *
 * Facets and view are domain-checked values out of a fixed list, so they are
 * written out. TAG LABELS are free text a browser sent, so only how MANY were
 * selected is recorded, next to the size of the vocabulary they were checked
 * against — enough to read a timing by, and nothing a reader typed. Same rule the
 * query bodies follow: a value from outside is data, never text.
 */
const shapeOf = (state: BoardState, tags: string[]): Record<string, unknown> => ({
  st: state.filter.status,
  pr: state.filter.priority,
  v: state.filter.view,
  g: state.filter.group,
  tags: state.filter.tags.length,
  vocab: tags.length,
  page: state.page,
});

/**
 * The board state a request's query string describes, or a 400.
 *
 * The tag vocabulary is read first because it IS the tag filter's domain: a label
 * is free text, so the only honest check on one arriving from a URL is "is this a
 * tag this workspace actually uses". It is the same read the chips are drawn from,
 * so it is passed back rather than fetched twice.
 */
async function boardStateOf(
  parsed: URL,
  res: http.ServerResponse,
  t: Trace,
): Promise<{ state: BoardState; tags: string[] } | null> {
  const tags = await t.read(
    "tags",
    () => availableTags(ctx),
    (v) => v.length,
  );
  try {
    const state = decodeFilter(parsed.searchParams, tags);
    t.describe(shapeOf(state, tags));
    return { state, tags };
  } catch (e) {
    if (!(e instanceof FilterError)) throw e;
    // A hand-edited or stale URL is a CLIENT error, and it is answered rather than
    // silently narrowed: dropping the value the app does not recognise would widen
    // the board, which is the failure nobody notices.
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(`bad filter: ${e.message}\n`);
    return null;
  }
}

// ---- The "add blocker" picker ------------------------------------------------
//
// The longest a search term is allowed to be. Stardust has its own limits (262,144
// UTF-8 bytes, 256 distinct analyzed terms) and refuses anything past them with a
// stable diagnostic, so this cap is not what makes the read safe — the term being a
// VALUE in a JSON body rather than text spliced into a query is what does that.
// This is here because a search box is an open pipe from a browser into a query,
// and eighty characters is more than a title, so anything longer is not a search.
const CAND_QUERY_MAX = 80;

/** A search term as it arrives from the browser's `$candQ` signal. Anything that
 *  is not a string, or is only whitespace, means "nothing typed" — which is the
 *  unsearched picker, not an empty search. */
const candQuery = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, CAND_QUERY_MAX) : "");

/**
 * The candidates the picker should show for one todo and one search term.
 *
 * The two filters that were always here stay here, and they are the reason this is
 * one function rather than a query the route calls directly: a todo may not depend
 * on itself, and a todo already listed above the picker is not a candidate for
 * being added again. Both apply to the searched list exactly as they applied to the
 * unsearched one — a search must not be a way around them.
 *
 * `capped` is measured against the RAW read, before those two filters, because
 * that is the question the note under the list answers: did the QUERY stop early,
 * or is this everything there was. Filtering afterwards can only shrink the list,
 * and shrinking it does not mean more rows exist.
 */
async function pickerCandidates(
  t: Trace,
  id: number,
  blockerIds: Set<number>,
  term: string,
): Promise<{ candidates: { id: number; title: string }[]; capped: boolean }> {
  // Named for which read it was: an fts search and the unsearched list are two
  // different queries with two different costs, and a breakdown that called both
  // "picker" would average them into something true of neither.
  const found = await t.read(
    term ? "search" : "picker",
    () => (term ? searchTodoOptions(ctx, viewPersona, term) : todoOptions(ctx, viewPersona)),
    (rows) => rows.length,
  );
  return {
    candidates: found.filter((o) => o.id !== id && !blockerIds.has(o.id)),
    capped: found.length >= (term ? SEARCH_LIMIT : PICKER_LIMIT),
  };
}

// Assemble everything the DETAIL route (/todo/<id>) needs from Stardust.
async function detailData(t: Trace, id: number): Promise<{ todo: any; opts: DetailOpts } | null> {
  // The detail page is eight reads deep, which is not obvious from reading it and
  // was not visible from outside at all. Each one carries its row count for the
  // same reason the board's do: `blocks 0` after a rewrite is either the truth or a
  // silently broken join, and only the count tells you which.
  const e = await t.read(
    "entity",
    () => readEntity(id),
    (x) => (x && x.title ? 1 : 0),
  );
  if (!e || !e.title) return null;
  const todo = {
    id,
    title: String(e.title ?? ""),
    done: e.done === true,
    priority: (e.priority as Priority) ?? "med",
    status: (e.status as Status) ?? "todo",
    draft: e.draft === true,
    lastActor: (e.lastActor as string) ?? undefined,
  };
  const blockers = await t.read(
    "blockers",
    () => blockersOf(id),
    (bs) => bs.length,
  );
  const openBlockers = blockers.filter((b) => b.status !== "done");
  const effStatus = effectiveStatus({ status: todo.status, blocked: openBlockers.length > 0 });
  const blockerIds = new Set(blockers.map((b) => b.id));
  // The picker opens unsearched. A repaint of this fragment cannot know what the
  // browser has typed since — the search lives in a signal, and this stream's
  // signals were captured when it connected — so a repaint arriving mid-search puts
  // the default list back under a filled search box. That needs a concurrent change
  // to THIS todo while the picker is open, and the next keystroke corrects it.
  const { candidates, capped } = await pickerCandidates(t, id, blockerIds, "");
  const tags = await t.read(
    "tags",
    () => tagsOf(ctx, id),
    (v) => v.length,
  );
  // The row count is what this read RETURNED, and it is now the same eight the
  // page renders. It used to be the whole timeline — 17 entries on the demo's
  // busiest todo, attributed one HTTP round trip at a time and then sliced to the
  // last eight by this line, which is what made it 44ms for a fragment showing
  // eight. `statusHistory` asks the fact log for the newest `HISTORY_LIMIT` and
  // attributes them in one query (history.ts). The number in the log got smaller
  // because the read did, which is worth saying out loud: a read that returns less
  // is faster for reasons that are not always an improvement, and this one is only
  // an improvement because the rows it stopped fetching were being thrown away.
  const history = (await t.read(
    "history",
    () => statusHistory(id),
    (h) => h.length,
  )) as HistEntry[];
  const role = await curRole();
  const commands = await t.read(
    "commands",
    () => visibleCommands("todo", role),
    (c) => c.length,
  );
  const canPublish = e.draft === true && (e.author as { "#": number } | undefined)?.["#"] === viewPersona;
  // "Blocks" = titles of todos that depend on THIS one (reverse dep edge).
  const blocks = (
    await t.read(
      "blocks",
      () => blockedByTodo.read({ todo: { "#": id } }),
      (r) => r.length,
    )
  ).map((r) => r.title as string);
  const due = (e.due as { "#utc"?: string } | undefined)?.["#utc"];
  // The entity's last transaction NOW — the CTA embeds it as its Tx-Check-Last
  // guard, so a transition only commits if the todo hasn't moved since render.
  const expectTx = await t.read(
    "lastTx",
    () => lastTx(id),
    (tx) => (tx ? 1 : 0),
  );
  return {
    todo,
    opts: {
      effStatus,
      blockers,
      candidates,
      candSearch: { q: "", capped },
      blocks,
      tags,
      history,
      commands,
      canPublish,
      due,
      expectTx,
    },
  };
}

// Re-patch #detail (the whole detail fragment) after a mutation. `why` names what
// asked for it — the paint a stream opens with, a pushed entity snapshot, or the
// write the reader just made — so a repeated repaint is countable rather than
// inferred from how the page felt.
async function sendDetail(stream: any, id: number, why: string) {
  const t = new Trace("detail-paint", why);
  t.describe({ todo: id });
  const d = await detailData(t, id);
  if (d) stream.patchElements(t.render(() => detailFragment(d.todo, d.opts)));
  t.done();
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url ?? "/", "http://localhost");
  const url = parsed.pathname;
  const method = req.method ?? "GET";
  const seg = url.split("/").filter(Boolean); // path segments

  try {
    // Vendored assets (datastar + the fonts). Serving them ourselves keeps every
    // request on one origin, so nothing third-party sits in front of first paint.
    if (seg[0] === "static" && method === "GET") {
      await serveStatic(seg.slice(1), res);
      return;
    }
    // The board. Everything narrowing it is in the query string, so this route is
    // the whole of "a filtered board is a URL": bookmarkable, shareable, and back
    // and forward do what they say. Two people opening one link get two
    // independent views — where `/s/<sid>` handed them the same mutable session
    // and let them overwrite each other's clicks.
    if (url === "/" && method === "GET") {
      const t = new Trace("board");
      const got = await boardStateOf(parsed, res, t);
      if (!got) return;
      const view = await boardView(t, got.state, got.tags);
      const html = t.render(() => page(got.state, view));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // `?debug=1` returns the SAME document with the record appended as a comment,
      // so what an agent measures is the response a browser gets rather than a
      // debug-only code path. `curl -s '…?debug=1' | tail -2` is the whole protocol.
      const rec = t.done();
      res.end(debug(parsed) ? html + debugComment(rec) : html);
      return;
    }
    // Demo helper: copy-paste curl commands to watch a page-set (the `page-rows`
    // reactor + a per-stream `ps` bind) and the transaction bus. The board's ROW
    // query is deliberately not offered here: it is a dry-run built per read with
    // the filter inlined, so there is no stored reactor to subscribe to and
    // nothing to bind.
    if (url === "/page.json" && method === "GET") {
      const rid = await pageRows.id();
      const cid = await boardCounts.id();
      const open = pooledPageSets();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            reactorId: rid,
            idlePageSets: open,
            // The other standing subscription, and the answer to "is this process
            // holding anything it should not be": `<workspace>:<viewer>` → how many
            // open board streams. With no board open it is `{}` a grace period later.
            countsReactorId: cid,
            countScopes: liveCountScopes(),
            page: `curl -N -H 'Accept: application/x-ndjson' -G --data-urlencode 'bind={ps {# ${open[0] ?? "<open a board first>"}}}' "${BASE}/reactors/${rid}/results"`,
            counts: `curl -N -H 'Accept: application/x-ndjson' -G --data-urlencode 'bind={ws {# ${ctx.workspaceId}} viewer {# ${viewPersona}}}' "${BASE}/reactors/${cid}/results"`,
            transactions: `curl -N -H 'Accept: application/x-ndjson' "${BASE}/events/bus/stardust/transactions"`,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Long-lived stream for ONE board. Its query string is the filter, fixed for
    // the life of the stream: a filter change is a navigation, so it is a new
    // document opening a new stream, and this one is closed by the browser.
    if (url === "/stream" && method === "GET") {
      // The stream's own setup is its own record — the tag vocabulary is read once
      // per STREAM rather than once per paint, so charging it to the first paint
      // would misattribute it to every filter change that follows.
      const t = new Trace("board-stream", "connect");
      const got = await boardStateOf(parsed, res, t);
      if (!got) return;
      const { state, tags } = got;
      // One page-set per STREAM. It is the identity the `page-rows` subscription
      // binds to, and a stream is exactly the lifetime that identity has meaning
      // for — a session entity outlived the tab that made it, and the demo had 84
      // of them for twelve todos.
      const pgset = await t.read(
        "lease",
        () => leasePageSet(),
        (ps) => ps.slots.length,
      );
      t.done();
      let closed = false;
      let inner: AbortController | null = null;
      const board = { repaint: () => {} };
      // The chips this stream is showing, patched when the tally MOVES rather than
      // when the page does. It is a render with no read behind it — the numbers came
      // out of memory, pushed by the reactor — which is why it is worth its own
      // record: `board-chips` in the log is a repaint that cost a query nowhere.
      const chips = { patch: (_c: Counts) => {} };
      // One hold per STREAM, the same lifetime as the page-set beside it: taken here,
      // given back on close, re-keyed by each paint if "view as" or the workspace has
      // moved. The subscription behind it outlives one stream by a grace period and
      // no longer (counts.ts), so a filter change re-uses it and a closed tab does
      // not keep it.
      const holder = holdCounts((c) => chips.patch(c));
      req.on("close", () => {
        closed = true;
        inner?.abort();
        openBoards.delete(board);
        releasePageSet(pgset); // in memory: closing a stream writes nothing
        holder.release(); // also free: the subscription goes when the last hold does
      });
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        chips.patch = (c) => {
          const ct = new Trace("board-chips", "push");
          ct.describe(shapeOf(state, tags));
          stream.patchElements(ct.render(() => filterBar(state, c, tags)));
          stream.patchElements(ct.render(() => sidebar(state, c)));
          ct.done();
        };
        // What the page-set currently names, as `page-rows` would project it. An
        // emission matching this is one the render itself caused, or a write that
        // changed nothing this page can show — either way there is nothing to
        // repaint. It is the app's own result-equality suppression, over exactly the
        // fields the subscription is sensitive to, so nothing a reader would have
        // seen can be dropped by it.
        let painted = "";
        const paint = (why: string) =>
          void renderBoard(stream, state, pgset, tags, holder, why)
            .then((k) => {
              painted = k;
            })
            .catch((e) => console.error("render:", e));
        board.repaint = () => paint("repaint");
        openBoards.add(board);
        let first = true; // the paint every stream opens with, vs one after a drop
        while (!closed) {
          inner = new AbortController();
          // Paint BEFORE subscribing. The page-set has to be written for the
          // subscription to be about anything, and writing it invalidates the
          // reactor — so subscribing first meant an empty first emission, a full
          // render, and then an echo that triggered a second identical render. One
          // board read per stream instead of two.
          await renderBoard(stream, state, pgset, tags, holder, first ? "open" : "reopen")
            .then((k) => {
              painted = k;
            })
            .catch((e) => console.error("render:", e));
          first = false;
          // Subscribe to the PAGE, not the whole filtered set. The reactor is an
          // invalidation signal rather than a data source: it fires when a row on
          // screen changes, and the render re-reads the page properly so ordering
          // and shape come from one place. Edits to rows NOT on the page are
          // silent — membership moves only when the app rewrites the page-set.
          await watchPage(
            pgset,
            (rows) => {
              if (frameKey(rows) === painted) return; // our own echo
              paint("push");
            },
            inner.signal,
          );
          // Only a client close aborts inner now. A dropped upstream stream (idle
          // timeout) did NOT abort → back off before resubscribing.
          if (!closed && !inner.signal.aborted) await new Promise((r) => setTimeout(r, 500));
        }
      });
      return;
    }

    // DETAIL page (real route): GET /todo/<id> — replaces the old menu overlay.
    if (seg[0] === "todo" && seg.length === 2 && method === "GET") {
      const id = Number(seg[1]);
      const t = new Trace("detail");
      t.describe({ todo: id });
      const d = await detailData(t, id);
      if (!d) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const html = t.render(() => detailPage(d.todo, d.opts));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const rec = t.done();
      res.end(debug(parsed) ? html + debugComment(rec) : html);
      return;
    }

    // BLOCKER PICKER search: GET /todo/<id>/candidates — patches #candlist alone.
    //
    // One element, not the fragment: the search box is INSIDE the detail fragment,
    // so re-patching the fragment would replace the input the user is typing in.
    // The term arrives the way Datastar sends signals on a GET (`?datastar=<json>`),
    // debounced in the browser at 250ms, so this is one request per pause rather
    // than one per keystroke.
    if (seg[0] === "todo" && seg[2] === "candidates" && method === "GET") {
      const id = Number(seg[1]);
      const term = candQuery(getSignals(req).candQ);
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        const t = new Trace("picker", term ? "search" : "clear");
        // The term itself never reaches the log — it is text a person typed. Its
        // LENGTH is what a timing needs, because what bounds an fts read is the
        // term, and a one-character term and a ten-character one are different
        // questions with different answers.
        t.describe({ todo: id, qlen: term.length });
        const blockerIds = new Set(
          (
            await t.read(
              "blockers",
              () => blockersOf(id),
              (bs) => bs.length,
            )
          ).map((b) => b.id),
        );
        const { candidates, capped } = await pickerCandidates(t, id, blockerIds, term);
        stream.patchElements(t.render(() => candidateList(id, candidates, { q: term, capped })));
        t.done();
      });
      return;
    }

    // DETAIL live stream: GET /todo/<id>/stream — re-patches #detail on change.
    if (seg[0] === "todo" && seg[2] === "stream" && method === "GET") {
      const id = Number(seg[1]);
      let closed = false;
      const ac = new AbortController();
      req.on("close", () => {
        closed = true;
        ac.abort();
      });
      let first = true; // the paint the pane opens with, vs one Stardust pushed
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        // `GET /entities/{id}` without `max` is Stardust's own live form: current
        // snapshot, then one per change to this todo's facts. So the repaint trigger
        // is a subscription rather than app code sifting the commit bus.
        //
        // Narrower than the tripwire it replaces, deliberately: the scope is this
        // entity's own facts, so a new tag edge or a blocker's status change does not
        // land here. The browser that makes such a change repaints from its own
        // request; another browser sees it on next load.
        while (!closed) {
          await sendDetail(stream, id, first ? "open" : "reopen"); // paint, then repaint per pushed snapshot
          first = false;
          await watchEntity(id, () => void sendDetail(stream, id, "push").catch(() => {}), ac.signal);
          if (!closed && !ac.signal.aborted) await new Promise((r) => setTimeout(r, 500));
        }
      });
      return;
    }

    // "View as" role switch (RBAC demo) — drives visibility + command projection.
    if (seg[0] === "viewas" && method === "POST") {
      viewPersona = seg[1] === "member" ? MEMBER_PERSONA : OWNER_PERSONA;
      // The viewer is inlined into the board body from process state, so there is
      // nothing to write — every open board just has to paint again. It used to be
      // a fact on each session, which is why this used to be a write per session.
      repaintAll();
      noopStream(req, res);
      return;
    }

    // Command palette (⌘K): /palette renders the global commands; /palette/0 closes.
    if (seg[0] === "palette" && method === "GET") {
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        if (seg[1] === "0") {
          stream.patchElements('<div id="palette"></div>');
          return;
        }
        const role = await curRole();
        stream.patchElements(palette(await visibleCommands("global", role)));
      });
      return;
    }

    // Execute a command: /command/<cmdId>[/<targetTodoId>]. The write boundary
    // re-checks the SAME catalog + role, so a denied command can't slip through.
    if (seg[0] === "command" && method === "POST") {
      const cmdId = seg[1];
      const target = seg[2] ? Number(seg[2]) : null;
      const role = await curRole();
      const allowed = await authorizeCommand(cmdId, role);
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        if (!allowed) {
          stream.patchSignals(JSON.stringify({ toast: `Denied: your role cannot run "${cmdId}".` }));
          return;
        }
        let msg = "";
        if (cmdId === "todo.complete" && target) {
          await setStatus(ctx, target, "done", actorName());
          msg = "Marked complete.";
        } else if (cmdId === "todo.delete" && target) {
          await removeTodo(ctx, target);
          msg = "Todo deleted.";
        } else if (cmdId === "todo.duplicate" && target) {
          const e = await readEntity(target);
          await addTodo(ctx, `${String(e.title ?? "todo")} (copy)`, (e.priority as Priority) ?? "med", {}, actorName());
          msg = "Todo duplicated.";
        } else {
          msg = `${allowed.label} — done (demo).`;
        }
        stream.patchSignals(JSON.stringify({ toast: msg }));
      });
      return;
    }

    // Per-todo actions: /todo/<id>/<action>/<arg>[?expect=<tx>]
    if (seg[0] === "todo" && method === "POST") {
      const id = Number(seg[1]);
      const action = seg[2];
      const arg = seg[3];
      // Guarded transition: the detail CTA sends ?expect=<tx>. The segmented
      // status control (manual override) sends none → no precondition.
      const expect = Number(new URL(req.url ?? "", "http://x").searchParams.get("expect")) || undefined;
      let conflict = false;
      try {
        if (action === "status") await setStatus(ctx, id, arg as Status, actorName(), expect);
        else if (action === "priority") await setPriority(ctx, id, arg as Priority, actorName());
        else if (action === "block") await addDependency(ctx, id, Number(arg), viewPersona);
        else if (action === "unblock") await removeDependency(ctx, id, Number(arg));
      } catch (e) {
        if (e instanceof TxConflictError)
          conflict = true; // stale write — refuse, don't clobber
        else throw e;
      } // refresh the list board(s)
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        if (conflict) {
          stream.patchSignals(JSON.stringify({ toast: "Someone changed this task — refreshed to the latest." }));
        }
        await sendDetail(stream, id, action ?? "write"); // deterministically refresh (covers dep changes + conflict)
      });
      return;
    }

    const switchMatch = url.match(/^\/switch\/(\d+)$/);
    if (switchMatch && method === "POST") {
      ctx = await openWorkspace(personaId, Number(switchMatch[1]));
      // The workspace is inlined from process state too. The filter stays what the
      // reader's URL says — a different workspace has different tags, so a tag chip
      // may now select nothing, which is a visibly empty board rather than a wrong
      // one. (One active workspace per server is a demo simplification; a real one
      // would put the workspace in the URL beside the filter.)
      repaintAll();
      noopStream(req, res);
      return;
    }

    if (url === "/new-workspace" && method === "POST") {
      const reader = await ServerSentEventGenerator.readSignals(req);
      const name = String((reader.success ? (reader.signals as any)?.newWs : "") ?? "").trim();
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        if (!name) return;
        const ws = await createWorkspace(personaId, name);
        ctx = await openWorkspace(personaId, ws.id);
        repaintAll();
        stream.patchSignals(JSON.stringify({ newWs: "" }));
      });
      return;
    }

    if (url === "/add" && method === "POST") {
      const reader = await ServerSentEventGenerator.readSignals(req);
      const s = (reader.success ? reader.signals : {}) as {
        newTitle?: string;
        newPriority?: Priority;
        newDraft?: boolean;
      };
      const title = (s.newTitle ?? "").trim();
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        if (!title) {
          stream.patchSignals(JSON.stringify({ error: "Title can't be empty." }));
          return;
        }
        // Authored by the acting persona; a draft is visible only to them.
        await addTodo(
          ctx,
          title,
          s.newPriority ?? "med",
          { author: { "#": viewPersona }, draft: s.newDraft === true },
          actorName(),
        );
        stream.patchSignals(JSON.stringify({ newTitle: "", newDraft: false, error: "" }));
      });
      return;
    }

    // Publish a draft (author-only) — makes it workspace-visible.
    const publishMatch = url.match(/^\/publish\/(\d+)$/);
    if (publishMatch && method === "POST") {
      const id = Number(publishMatch[1]);
      const expect = Number(new URL(req.url ?? "", "http://x").searchParams.get("expect")) || undefined;
      let ok = true;
      let conflict = false;
      try {
        await publishTodo(ctx, id, viewPersona, expect);
      } catch (e) {
        if (e instanceof TxConflictError)
          conflict = true; // draft moved since render
        else ok = false; // not the author
      }
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        if (conflict) stream.patchSignals(JSON.stringify({ toast: "This draft changed — refreshed to the latest." }));
        else if (!ok) stream.patchSignals(JSON.stringify({ toast: "Only the author can publish this draft." }));
        await sendDetail(stream, id, "publish");
      });
      return;
    }

    const toggleMatch = url.match(/^\/toggle\/(\d+)$/);
    if (toggleMatch && method === "POST") {
      await toggleTodo(ctx, Number(toggleMatch[1]), actorName());
      noopStream(req, res);
      return;
    }

    const removeMatch = url.match(/^\/remove\/(\d+)$/);
    if (removeMatch && method === "DELETE") {
      await removeTodo(ctx, Number(removeMatch[1]));
      noopStream(req, res);
      return;
    }

    // X-ray "copy as RON": the stored body of ONE named reactor, as text.
    //
    // The name is checked against the app's own catalog before it is looked up —
    // not because a marker lookup is dangerous, but because an open name->body
    // endpoint invites using this page as a general database browser. The console
    // at /reactors already is one, behind its own auth.
    if (seg[0] === "xray" && seg[1] === "ron" && seg.length === 3 && method === "GET") {
      const name = decodeURIComponent(seg[2]);
      if (!RON_EXPORTABLE.has(name)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("unknown reactor");
        return;
      }
      const id = await lookupRef("reactorRef", name);
      if (id === undefined) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not provisioned");
        return;
      }
      const body = await readReactorRon(id);
      const binds = parsed.searchParams.get("runnable")
        ? runnableBinds(name, {
            ps: parsed.searchParams.get("ps") ?? undefined,
            todo: parsed.searchParams.get("todo") ?? undefined,
          })
        : {};
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(withBindClause(body, binds));
      return;
    }

    // ---- Glass box: /inspect and its real-data feeds -----------------------
    if (seg[0] === "inspect") {
      // The standalone page.
      if (seg.length === 1 && method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(inspectPage(recentRequests()));
        return;
      }

      // The request records, as the glass box shows them and as a machine reads
      // them. The table is rendered from the same ring on page load; this refreshes
      // it in place, which is what makes the panel useful while you drive the board
      // in the other tab.
      if (seg[1] === "timings" && method === "GET") {
        ServerSentEventGenerator.stream(req, res, (stream) => {
          stream.patchElements(timingTable(recentRequests()));
        });
        return;
      }
      // The same ring as JSON — the only way to get the SSE paints out, since a
      // stream cannot carry the HTML comment `?debug=1` appends to a document. An
      // agent that changed a filter reads its paint records here.
      if (seg[1] === "timings.json" && method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(recentRequests(), null, 2));
        return;
      }

      // Live transaction feed — long-lived subscription to the commit bus,
      // reconnecting on idle drop (like /stream).
      if (seg[1] === "stream" && method === "GET") {
        let closed = false;
        const ac = new AbortController();
        req.on("close", () => {
          closed = true;
          ac.abort();
        });
        ServerSentEventGenerator.stream(req, res, async (stream) => {
          stream.patchElements(feedList(feedBuf)); // show what we already have
          while (!closed) {
            await streamTxFeed(stream, ac.signal, feedBuf);
            if (!closed && !ac.signal.aborted) await new Promise((r) => setTimeout(r, 500));
          }
        });
        return;
      }

      // Fact provenance for one entity (id in the path, or from the focus input).
      if (seg[1] === "entity" && method === "GET") {
        const id = seg[2] ? Number(seg[2]) : Number(String(getSignals(req).focusId ?? "").trim());
        ServerSentEventGenerator.stream(req, res, async (stream) => {
          if (!id) {
            stream.patchElements('<div id="prov"><div class="hint">Enter a valid entity id.</div></div>');
            return;
          }
          stream.patchElements(`<div id="prov"><div class="hint">replaying entity #${id} facts…</div></div>`);
          stream.patchElements(provenancePanel(await provenance(id), id));
        });
        return;
      }

      // Replay: load the full log (cached), then scrub through it.
      if (seg[1] === "replay" && seg.length === 2 && method === "GET") {
        ServerSentEventGenerator.stream(req, res, async (stream) => {
          stream.patchElements(
            '<div id="replay"><div class="hint">replaying the full commit log from event 0…</div></div>',
          );
          replayCache = await collectReplay();
          stream.patchElements(scrubber(replayCache));
          stream.patchSignals(JSON.stringify({ rp: Math.max(0, replayCache.length - 1) }));
        });
        return;
      }
      if (seg[1] === "replay" && seg[2] === "at" && method === "GET") {
        const n = Number(getSignals(req).rp ?? 0);
        ServerSentEventGenerator.stream(req, res, async (stream) => {
          if (replayCache && replayCache.length) {
            stream.patchElements(`<div id="replayview">${replayView(replayCache, n)}</div>`);
          }
        });
        return;
      }
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("server error");
  }
});

server.listen(PORT, async () => {
  console.log(`todo web UI  -> http://localhost:${PORT}`);
  console.log(`stardust     -> ${process.env.STARDUST_URL ?? "http://localhost:1981"}`);
  // The copy-paste demo commands (also at GET /page.json). A page-set is leased
  // per open stream, so there is no id to print until a board is open — the bind
  // below takes one from /page.json.
  const rid = await pageRows.id();
  // A restart used to abandon its page-sets and mint fresh ones per stream. The
  // pool is discoverable — `kind pgset` is a query — so it is adopted instead.
  const pooled = await recoverPool();
  console.log(`\n  page reactor ${rid} · ${pooled} page-set(s) recovered`);
  console.log(
    `  page     :  curl -N -H 'Accept: application/x-ndjson' -G --data-urlencode 'bind={ps {# <pgset>}}' "${BASE}/reactors/${rid}/results"`,
  );
  console.log(`  tx bus   :  curl -N -H 'Accept: application/x-ndjson' "${BASE}/events/bus/stardust/transactions"\n`);
});
