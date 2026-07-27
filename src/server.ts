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
import type { EntityId } from "./stardust.ts";
import { createPersona, createWorkspace, ensureUser, grantAccess, listPersonas, roleOf } from "./tenancy.ts";
import { authorizeCommand, ensureCommandCatalog, visibleCommands } from "./commands.ts";
import { addDependency, removeDependency, tagsOf } from "./features.ts";
import { aggregateCounts, availableTags, blockerMap, blockersOf, effectiveStatus, todoOptions } from "./board.ts";
import { type BoardScope, boardQuery, readSnapshot } from "./board-query.ts";
import { type BoardState, FilterError, decodeFilter } from "./filter.ts";
import { BASE, TxConflictError, lastTx, readEntity, readReactorRon, watchEntity } from "./stardust.ts";
import { DECLARED, blockedByTodo, pageRows } from "./queries.ts";
import { leasePageSet, releasePageSet, watchPage, writePageSet } from "./pageset.ts";
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
  visibleTotal,
} from "./view.ts";
import { type DetailOpts, type HistEntry, detailFragment, detailPage } from "./detail.ts";
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
} from "./inspect.ts";

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
    case "board-counts":
    case "todo-options":
      return { ws, viewer };
    case "board-blockers":
    case "board-tags":
      return { ws };
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

/** Page-sets with a stream behind them, so /page.json can offer a real bind. */
const livePageSets = new Set<EntityId>();

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
// NOTE what paging does and does not bound here. The board is one page now, but the
// three reads beside it are not: `aggregateCounts` tallies every visible row (that
// is what the chips mean), and `blockerMap`/`availableTags` are whole-workspace
// queries. So this function is still O(workspace) — paging bounded the board's
// response and its render, not the cost of a page view. Saying so here because the
// obvious next question is why the page is not fast yet.
async function boardData(state: BoardState, pgset: EntityId | null, tags: string[]) {
  const [snap, counts, blockers] = await Promise.all([
    readSnapshot(boardQuery(scopeNow(), state.filter), state.page),
    aggregateCounts(ctx, viewPersona), // counts over the SAME visible set
    blockerMap(ctx),
  ]);
  // Record what this stream is now looking at, so the page subscription follows it.
  if (pgset !== null)
    await writePageSet(
      pgset,
      snap.rows.map((r) => r.id),
    );
  return { snap, todos: snap.rows as unknown as Todo[], counts, tags, blockers }; // SnapshotRow is Todo-shaped
}

// Render the filter bar + board over the stream, for ONE open board. The filter
// arrives with the stream's own URL and does not change for its lifetime — a
// different filter is a different stream — so it is captured once and passed down.
async function renderBoard(stream: any, state: BoardState, pgset: EntityId) {
  const tags = await availableTags(ctx);
  const { snap, todos, counts, blockers } = await boardData(state, pgset, tags);
  stream.patchElements(filterBar(state, counts.status, counts.priority, tags));
  stream.patchElements(boardFragment(todos, blockers, state.filter, { state, hasMore: snap.hasMore }, pgset));
  stream.patchElements(sidebar(state, counts.status)); // desktop rail (hidden < 900px)
}

// The same board, rendered into the initial HTML so the first paint is the real
// page. Datastar morphs its first patch over identical markup, so this is purely
// additive — nothing downstream changes.
//
// No page-set: the SSR pass has no subscription to point at one. The stream that
// the document opens a moment later leases its own and writes it.
async function boardView(state: BoardState, tags: string[]): Promise<BoardView> {
  const { snap, todos, counts, blockers } = await boardData(state, null, tags);
  return {
    sidebar: sidebar(state, counts.status),
    filterbar: filterBarEl(state, counts.status, counts.priority, tags),
    board: boardEl(todos, blockers, state.filter, { state, hasMore: snap.hasMore }),
    visible: visibleLabel(todos.length, snap.hasMore),
    total: visibleTotal(counts.status),
  };
}

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
): Promise<{ state: BoardState; tags: string[] } | null> {
  const tags = await availableTags(ctx);
  try {
    return { state: decodeFilter(parsed.searchParams, tags), tags };
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

// Assemble everything the DETAIL route (/todo/<id>) needs from Stardust.
async function detailData(id: number): Promise<{ todo: any; opts: DetailOpts } | null> {
  const e = await readEntity(id);
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
  const blockers = await blockersOf(id);
  const openBlockers = blockers.filter((b) => b.status !== "done");
  const effStatus = effectiveStatus({ status: todo.status, blocked: openBlockers.length > 0 });
  const blockerIds = new Set(blockers.map((b) => b.id));
  const candidates = (await todoOptions(ctx, viewPersona)).filter((o) => o.id !== id && !blockerIds.has(o.id));
  const tags = await tagsOf(ctx, id);
  const history = ((await statusHistory(id)) as HistEntry[]).slice(-8); // most recent changes
  const role = await curRole();
  const commands = await visibleCommands("todo", role);
  const canPublish = e.draft === true && (e.author as { "#": number } | undefined)?.["#"] === viewPersona;
  // "Blocks" = titles of todos that depend on THIS one (reverse dep edge).
  const blocks = (await blockedByTodo.read({ todo: { "#": id } })).map((r) => r.title as string);
  const due = (e.due as { "#utc"?: string } | undefined)?.["#utc"];
  // The entity's last transaction NOW — the CTA embeds it as its Tx-Check-Last
  // guard, so a transition only commits if the todo hasn't moved since render.
  const expectTx = await lastTx(id);
  return {
    todo,
    opts: { effStatus, blockers, candidates, blocks, tags, history, commands, canPublish, due, expectTx },
  };
}

// Re-patch #detail (the whole detail fragment) after a mutation.
async function sendDetail(stream: any, id: number) {
  const d = await detailData(id);
  if (d) stream.patchElements(detailFragment(d.todo, d.opts));
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
      const got = await boardStateOf(parsed, res);
      if (!got) return;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(got.state, await boardView(got.state, got.tags)));
      return;
    }
    // Demo helper: copy-paste curl commands to watch a page-set (the `page-rows`
    // reactor + a per-stream `ps` bind) and the transaction bus. The board's ROW
    // query is deliberately not offered here: it is a dry-run built per read with
    // the filter inlined, so there is no stored reactor to subscribe to and
    // nothing to bind.
    if (url === "/page.json" && method === "GET") {
      const rid = await pageRows.id();
      const open = [...livePageSets];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            reactorId: rid,
            openPageSets: open,
            page: `curl -N -H 'Accept: application/x-ndjson' -G --data-urlencode 'bind={ps {# ${open[0] ?? "<open a board first>"}}}' "${BASE}/reactors/${rid}/results"`,
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
      const got = await boardStateOf(parsed, res);
      if (!got) return;
      const { state } = got;
      // One page-set per STREAM. It is the identity the `page-rows` subscription
      // binds to, and a stream is exactly the lifetime that identity has meaning
      // for — a session entity outlived the tab that made it, and the demo had 84
      // of them for twelve todos.
      const pgset = await leasePageSet();
      livePageSets.add(pgset);
      let closed = false;
      let inner: AbortController | null = null;
      const board = { repaint: () => {} };
      req.on("close", () => {
        closed = true;
        inner?.abort();
        openBoards.delete(board);
        livePageSets.delete(pgset);
        void releasePageSet(pgset).catch((e) => console.error("page-set release:", e));
      });
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        const paint = () => void renderBoard(stream, state, pgset).catch((e) => console.error("render:", e));
        board.repaint = paint;
        openBoards.add(board);
        while (!closed) {
          inner = new AbortController();
          // Subscribe to the PAGE, not the whole filtered set. The reactor is an
          // invalidation signal rather than a data source: it fires when a row on
          // screen changes, and the render re-reads the page properly so ordering
          // and shape come from one place. Edits to rows NOT on the page are
          // silent — membership moves only when the app rewrites the page-set.
          await watchPage(pgset, paint, inner.signal);
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
      const d = await detailData(id);
      if (!d) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(detailPage(d.todo, d.opts));
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
          await sendDetail(stream, id); // paint, then repaint per pushed snapshot
          await watchEntity(id, () => void sendDetail(stream, id).catch(() => {}), ac.signal);
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
        await sendDetail(stream, id); // deterministically refresh the detail (covers dep changes + conflict)
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
        await sendDetail(stream, id);
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
        res.end(inspectPage());
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
  console.log(`\n  page reactor ${rid}`);
  console.log(
    `  page     :  curl -N -H 'Accept: application/x-ndjson' -G --data-urlencode 'bind={ps {# <pgset>}}' "${BASE}/reactors/${rid}/results"`,
  );
  console.log(`  tx bus   :  curl -N -H 'Accept: application/x-ndjson' "${BASE}/events/bus/stardust/transactions"\n`);
});
