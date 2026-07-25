// Datastar web UI: workspace-aware, with Linear-style filtering/grouping/
// aggregates (all powered by Stardust queries) and a dependency action menu.
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
  migrateVisibilityFields,
  publishTodo,
  removeTodo,
  setPriority,
  setStatus,
  toggleTodo,
} from "./todos.ts";
import { type WorkspaceCtx, defaultWorkspace, openWorkspace } from "./workspace.ts";
import type { EntityId } from "./stardust.ts";
import { createPersona, createWorkspace, ensureUser, grantAccess, listPersonas, roleOf } from "./tenancy.ts";
import { authorizeCommand, catalog, ensureCommandCatalog, project } from "./commands.ts";
import { addDependency, removeDependency, tagsOf } from "./features.ts";
import {
  type Filter,
  aggregateCounts,
  availableTags,
  blockerMap,
  effectiveStatus,
  emptyFilter,
  todoOptions,
} from "./board.ts";
import {
  type SessionHandle,
  createSession,
  ensureBoardReactor,
  readFilter,
  readSnapshot,
  refresh,
  retargetSession,
  setFilter,
  watchSnapshot,
} from "./session.ts";
import { BASE, TxConflictError, lastTx, readEntity, watchEntity } from "./stardust.ts";
import { blockedByTodo } from "./queries.ts";
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

const PORT = Number(process.env.PORT ?? 3000);

let ctx: WorkspaceCtx = await defaultWorkspace();

// Demo roles: the default persona owns the workspace; add a "Teammate" persona
// with a member grant so "view as" can switch role and drive the command
// projection. Commands themselves are seeded as data.
await ensureCommandCatalog();
await backfillActor(); // give pre-existing todos a lastActor so the board projection is complete
await migrateBlockedStatus(); // blocked-ness is derived now — revert any legacy stored "blocked" rows
await migrateVisibilityFields(ctx.personaId); // give legacy todos author + draft:false so visibility binds
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

// No durable-workflow worker: blocked-ness and project rollup are DERIVED on
// read (correlated $exists projections), so there is nothing to materialize or
// undo — the imperative worker is gone entirely.

// One inner controller per stream iteration; aborted to force a re-render.
const switchControllers = new Set<AbortController>();
// Re-render every open board/detail stream. ALSO bump the session `rev` so the
// canonical reactor re-emits to any terminal panes bound to this session — every
// board-changing action (filter toggle, todo mutation) refreshes the live curl,
// not just priority changes.
const rerenderAll = () => {
  // Bump every live session so any pane bound to one re-emits — a write is not
  // scoped to the browser that made it.
  for (const sid of liveSessions) void refresh(sessionOf(sid)).catch(() => {});
  for (const c of switchControllers) c.abort();
};

const noopStream = (req: http.IncomingMessage, res: http.ServerResponse) =>
  ServerSentEventGenerator.stream(req, res, () => {});
const toggle = <T>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

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

// Board SEARCH SESSION — one per BROWSER, not one per process.
//
// The filter state and viewer visibility live as facts in Stardust, and the sid
// travels in the URL (/s/<sid>) and as a Datastar signal, so two browsers on the
// same board hold two independent filters. The server keeps no filter state at
// all; every render reads the session back with readFilter().
//
// It used to be a single module-level session keyed by workspace+viewer, which
// meant every browser shared one filter AND every restart abandoned a session
// entity — the same accumulation the board reactor had.
const sessionOf = (sessionId: EntityId): SessionHandle => ({ sessionId, workspaceId: ctx.workspaceId });

/** sids with a live stream, so a write can nudge every open board to re-emit. */
const liveSessions = new Set<EntityId>();

/**
 * Move every live session to the current workspace + viewer, resetting its
 * filter. Needed because a session stores its own scope as facts: without this a
 * workspace switch would leave open boards rendering the workspace they were
 * created in. (One active workspace per server is a demo simplification.)
 */
async function rescope(): Promise<void> {
  for (const sid of liveSessions) {
    const h = sessionOf(sid);
    await retargetSession(h, ctx.workspaceId, viewPersona).catch((e) => console.error("rescope:", e));
    await setFilter(h, { ...emptyFilter }, actorName()).catch((e) => console.error("rescope filter:", e));
  }
}

/** A fresh session for a newly-arrived browser. */
async function newSession(): Promise<SessionHandle> {
  const h = await createSession(ctx.workspaceId, viewPersona, actorName());
  await setFilter(h, { ...emptyFilter }, actorName());
  return h;
}

/** The demo affordance (/session.json, the startup banner) needs *a* session. */
let demoSession: SessionHandle | null = null;
const ensureDemoSession = async (): Promise<SessionHandle> => (demoSession ??= await newSession());

/** The session a request names in its path: /s/<sid>/… */
function sidIn(seg: string[]): EntityId | null {
  if (seg[0] !== "s") return null;
  const v = Number(seg[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

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

// Everything the board renders from. The todo list is the session snapshot — the
// canonical reactor applies EVERY filter (priority, status, tags, views) +
// visibility + derivation server-side, so there is ONE read path feeding both the
// SSE patches and the server-rendered first paint.
async function boardData(session: SessionHandle, pushed?: Todo[]) {
  const [snap, counts, tags, blockers] = await Promise.all([
    pushed ? Promise.resolve(pushed) : readSnapshot(session),
    aggregateCounts(ctx, viewPersona), // counts over the SAME visible set
    availableTags(ctx),
    blockerMap(ctx),
  ]);
  return { todos: snap as unknown as Todo[], counts, tags, blockers }; // SnapshotRow is Todo-shaped
}

// Render the filter bar + board over the stream, for ONE session. `pushed` is the
// row set Stardust just emitted — passing it through avoids re-reading a snapshot
// we were handed a moment ago.
async function renderBoard(stream: any, session: SessionHandle, pushed?: Todo[]) {
  const [{ todos, counts, tags, blockers }, filter] = await Promise.all([
    boardData(session, pushed),
    readFilter(session),
  ]);
  const sid = session.sessionId;
  stream.patchElements(filterBar(sid, filter, counts.status, counts.priority, tags));
  stream.patchElements(boardFragment(todos, blockers, filter));
  stream.patchElements(sidebar(sid, filter, counts.status)); // desktop rail (hidden < 900px)
}

// The same board, rendered into the initial HTML so the first paint is the real
// page. Datastar morphs its first patch over identical markup, so this is purely
// additive — nothing downstream changes.
async function boardView(session: SessionHandle): Promise<BoardView> {
  const [{ todos, counts, tags, blockers }, filter] = await Promise.all([boardData(session), readFilter(session)]);
  return {
    sidebar: sidebar(session.sessionId, filter, counts.status),
    filterbar: filterBarEl(session.sessionId, filter, counts.status, counts.priority, tags),
    board: boardEl(todos, blockers, filter),
    visible: todos.length,
    total: visibleTotal(counts.status),
  };
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
  const blockers = (await blockerMap(ctx)).get(id) ?? [];
  const openBlockers = blockers.filter((b) => b.status !== "done");
  const effStatus = effectiveStatus({ status: todo.status, blocked: openBlockers.length > 0 });
  const blockerIds = new Set(blockers.map((b) => b.id));
  const candidates = (await todoOptions(ctx, viewPersona)).filter((o) => o.id !== id && !blockerIds.has(o.id));
  const tags = await tagsOf(ctx, id);
  const history = ((await statusHistory(id)) as HistEntry[]).slice(-8); // most recent changes
  const role = await curRole();
  const commands = project(await catalog("todo"), role);
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
  const url = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method ?? "GET";
  const seg = url.split("/").filter(Boolean); // path segments

  try {
    // Vendored assets (datastar + the fonts). Serving them ourselves keeps every
    // request on one origin, so nothing third-party sits in front of first paint.
    if (seg[0] === "static" && method === "GET") {
      await serveStatic(seg.slice(1), res);
      return;
    }
    // Root → a NEW session for this browser, then redirect so the sid is in the
    // URL. Reloading /s/<sid> reuses it; arriving at / again starts a fresh one,
    // which is what "a session per browser session" means here.
    if (url === "/" && method === "GET") {
      const s = await newSession();
      res.writeHead(302, { location: `/s/${s.sessionId}` });
      res.end();
      return;
    }
    // Session-scoped page. The sid in the path IS the session — it is handed to
    // the client as a signal so every later request carries it.
    if (seg[0] === "s" && seg.length === 2 && method === "GET") {
      const sid = Number(seg[1]);
      if (!Number.isFinite(sid) || sid <= 0) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(sid, await boardView(sessionOf(sid))));
      return;
    }
    // Demo helper: copy-paste curl commands to watch THIS session's snapshot
    // stream (canonical reactor + per-stream sid bind) and the transaction bus.
    if (url === "/session.json" && method === "GET") {
      const s = await ensureDemoSession();
      const rid = await ensureBoardReactor();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            sid: s.sessionId,
            reactorId: rid,
            snapshot: `curl -N -H 'Accept: application/x-ndjson' -G --data-urlencode 'bind={sid ${s.sessionId}}' "${BASE}/reactors/${rid}/results"`,
            transactions: `curl -N -H 'Accept: application/x-ndjson' "${BASE}/events/bus/stardust/transactions"`,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Long-lived stream: renders wsbar once per iteration, then the filtered
    // board on every change; re-iterates on switch/filter (inner abort).
    if (seg[0] === "s" && seg[2] === "stream" && method === "GET") {
      const sid = sidIn(seg);
      if (sid === null) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const session = sessionOf(sid);
      liveSessions.add(sid);
      let closed = false;
      let inner: AbortController | null = null;
      req.on("close", () => {
        closed = true;
        liveSessions.delete(sid);
        inner?.abort();
      });
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        // The board is driven by Stardust, not by the app watching the commit bus:
        // the reactor re-emits the whole result when this session's `rev` changes or
        // a todo field in its top-level `where` moves, and each emission is rendered
        // as-is. Nothing here decides what is relevant — the query already did.
        while (!closed) {
          inner = new AbortController();
          switchControllers.add(inner);
          await watchSnapshot(
            session,
            (rows) =>
              void renderBoard(stream, session, rows as unknown as Todo[]).catch((e) => console.error("render:", e)),
            inner.signal,
          );
          switchControllers.delete(inner);
          // Deliberate switch/close aborts inner → re-render instantly.
          // A dropped upstream stream (idle timeout) did NOT abort → back off.
          if (!closed && !inner.signal.aborted) await new Promise((r) => setTimeout(r, 500));
        }
      });
      return;
    }

    // Filter toggles: /filter/<facet>/<value>
    if (seg[0] === "s" && seg[2] === "filter" && method === "POST") {
      const [, , , facet, raw] = seg;
      const value = decodeURIComponent(raw ?? "");
      const sid = sidIn(seg);
      if (sid === null) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const session = sessionOf(sid);
      // Read-modify-write against THIS session: the filter is not server state,
      // so a toggle starts from what Stardust currently holds for this browser.
      const filter = await readFilter(session);
      if (facet === "status") filter.status = toggle(filter.status, value as Status);
      else if (facet === "priority") filter.priority = toggle(filter.priority, value as Priority);
      else if (facet === "tag") filter.tags = toggle(filter.tags, value);
      else if (facet === "view") filter.view = filter.view === (value as any) ? "all" : (value as any);
      else if (facet === "group") filter.group = value as any;
      await setFilter(session, filter, actorName());
      rerenderAll();
      noopStream(req, res);
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
        // Narrower than the tripwire it replaces, deliberately: it fires for THIS
        // todo's fields, not for a new tag edge or a blocker's status. The browser
        // that makes such a change repaints from its own request; another browser
        // sees it on next load.
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
      rerenderAll();
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
        stream.patchElements(palette(project(await catalog("global"), role)));
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
        rerenderAll();
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
      }
      rerenderAll(); // refresh the list board(s)
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
      await rescope();
      rerenderAll();
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
        await rescope();
        stream.patchSignals(JSON.stringify({ newWs: "" }));
        rerenderAll();
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
        rerenderAll();
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
      rerenderAll();
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
      rerenderAll();
      noopStream(req, res);
      return;
    }

    const removeMatch = url.match(/^\/remove\/(\d+)$/);
    if (removeMatch && method === "DELETE") {
      await removeTodo(ctx, Number(removeMatch[1]));
      rerenderAll();
      noopStream(req, res);
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
  // Pre-create the board session so `/` can redirect to /s/<sid>, and print the
  // copy-paste demo commands (also at GET /session.json).
  const s = await ensureDemoSession();
  const rid = await ensureBoardReactor();
  console.log(`\n  session ${s.sessionId} · canonical reactor ${rid}`);
  console.log(
    `  snapshot :  curl -N -H 'Accept: application/x-ndjson' -G --data-urlencode 'bind={sid ${s.sessionId}}' "${BASE}/reactors/${rid}/results"`,
  );
  console.log(`  tx bus   :  curl -N -H 'Accept: application/x-ndjson' "${BASE}/events/bus/stardust/transactions"\n`);
});
