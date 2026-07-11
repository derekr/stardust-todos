// Datastar web UI: workspace-aware, with Linear-style filtering/grouping/
// aggregates (all powered by Stardust queries) and a dependency action menu.
//
//   node src/server.ts        # http://localhost:3000

import http from "node:http";
import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/node";
import { type Priority, type Status, addTodo, removeTodo, setPriority, setStatus, toggleTodo } from "./todos.ts";
import { type WorkspaceCtx, defaultWorkspace, openWorkspace } from "./workspace.ts";
import {
  createPersona,
  createWorkspace,
  ensureUser,
  grantAccess,
  listPersonas,
  listWorkspaces,
  roleOf,
} from "./tenancy.ts";
import { authorizeCommand, catalog, ensureCommandCatalog, project } from "./commands.ts";
import { addDependency, removeDependency } from "./features.ts";
import {
  type Filter,
  availableTags,
  blockerMap,
  emptyFilter,
  filteredTodos,
  priorityCounts,
  statusCounts,
  todoOptions,
} from "./board.ts";
import { readEntity } from "./stardust.ts";
import { statusHistory } from "./history.ts";
import { startWorker } from "./workflow.ts";
import { boardFragment, filterBar, historySection, menuFragment, page, palette, toolbar, wsBar } from "./view.ts";

const PORT = Number(process.env.PORT ?? 3000);

let ctx: WorkspaceCtx = await defaultWorkspace();
let filter: Filter = { ...emptyFilter };

// Demo roles: the default persona owns the workspace; add a "Teammate" persona
// with a member grant so "view as" can switch role and drive the command
// projection. Commands themselves are seeded as data.
await ensureCommandCatalog();
const OWNER_PERSONA = ctx.personaId;
const demoUser = await ensureUser("default@local");
if (!(await listPersonas(demoUser)).some((p) => p.name === "Teammate")) {
  const mid = await createPersona(demoUser, "Teammate");
  await grantAccess(ctx.workspaceId, mid, "member");
}
const MEMBER_PERSONA = (await listPersonas(demoUser)).find((p) => p.name === "Teammate")!.id;
const personaId = ctx.personaId; // owner — used for wsbar + workspace ops
let viewPersona = OWNER_PERSONA; // "view as" — drives command projection + enforcement
const curRole = () => roleOf(viewPersona, ctx.workspaceId);
const actorName = () => (viewPersona === MEMBER_PERSONA ? "Teammate" : "Owner"); // stamped on writes

// A long-running server hosts many long-lived streams; a stray rejection from
// any of them must never take the process down. Log and keep serving.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

// Run the durable-workflow worker IN THIS PROCESS (no separate node worker).
const workerAbort = new AbortController();
startWorker(workerAbort.signal, (txId, applied) => {
  if (applied) console.log(`workflow: tx ${txId} -> applied ${applied}`);
}).catch((e) => console.error("worker stopped:", e));

// One inner controller per stream iteration; aborted to force a re-render.
const switchControllers = new Set<AbortController>();
const rerenderAll = () => {
  for (const c of switchControllers) c.abort();
};

const noopStream = (req: http.IncomingMessage, res: http.ServerResponse) =>
  ServerSentEventGenerator.stream(req, res, () => {});
const toggle = <T>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

// Render the filter bar + board for the current workspace & filter.
async function renderBoard(stream: any) {
  const [todos, sc, pc, tags, blockers] = await Promise.all([
    filteredTodos(ctx, filter),
    statusCounts(ctx),
    priorityCounts(ctx),
    availableTags(ctx),
    blockerMap(ctx),
  ]);
  stream.patchElements(filterBar(filter, sc, pc, tags));
  stream.patchElements(boardFragment(todos, blockers, filter));
  const role = await curRole();
  stream.patchElements(toolbar(role, project(await catalog("global"), role)));
}

async function menuElements(id: number): Promise<string> {
  if (!id) return menuFragment(null, [], []);
  const e = await readEntity(id);
  const todo = {
    id,
    title: String(e.title ?? ""),
    done: e.done === true,
    priority: (e.priority as Priority) ?? "med",
    status: (e.status as Status) ?? "todo",
  };
  const blockers = (await blockerMap(ctx)).get(id) ?? [];
  const blockerIds = new Set(blockers.map((b) => b.id));
  const candidates = (await todoOptions(ctx)).filter((o) => o.id !== id && !blockerIds.has(o.id));
  const role = await curRole();
  const todoCmds = project(await catalog("todo"), role);
  return menuFragment(todo, blockers, candidates, "loading", todoCmds); // history streams in after
}

// Render the menu instantly, then stream the (slower) status history into it.
async function sendMenu(stream: any, id: number) {
  stream.patchElements(await menuElements(id));
  if (id) stream.patchElements(historySection(await statusHistory(id)));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method ?? "GET";
  const seg = url.split("/").filter(Boolean); // path segments

  try {
    if (url === "/" && method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page());
      return;
    }

    // Long-lived stream: renders wsbar once per iteration, then the filtered
    // board on every change; re-iterates on switch/filter (inner abort).
    if (url === "/stream" && method === "GET") {
      let closed = false;
      let inner: AbortController | null = null;
      req.on("close", () => {
        closed = true;
        inner?.abort();
      });
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        const { watchTodos } = await import("./todos.ts");
        while (!closed) {
          inner = new AbortController();
          switchControllers.add(inner);
          stream.patchElements(wsBar(await listWorkspaces(personaId), ctx.workspaceId));
          await watchTodos(ctx, () => renderBoard(stream).catch((e) => console.error("render:", e)), inner.signal);
          switchControllers.delete(inner);
          // Deliberate switch/close aborts inner → re-render instantly.
          // A dropped upstream stream (idle timeout) did NOT abort → back off.
          if (!closed && !inner.signal.aborted) await new Promise((r) => setTimeout(r, 500));
        }
      });
      return;
    }

    // Filter toggles: /filter/<facet>/<value>
    if (seg[0] === "filter" && method === "POST") {
      const [, facet, raw] = seg;
      const value = decodeURIComponent(raw ?? "");
      if (facet === "status") filter.status = toggle(filter.status, value as Status);
      else if (facet === "priority") filter.priority = toggle(filter.priority, value as Priority);
      else if (facet === "tag") filter.tags = toggle(filter.tags, value);
      else if (facet === "view") filter.view = filter.view === (value as any) ? "all" : (value as any);
      else if (facet === "group") filter.group = value as any;
      rerenderAll();
      noopStream(req, res);
      return;
    }

    // Action menu overlay: /menu/<id>  (0 = close)
    if (seg[0] === "menu" && method === "GET") {
      const id = Number(seg[1] ?? 0);
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        await sendMenu(stream, id);
      });
      return;
    }

    // "View as" role switch — drives the command projection everywhere.
    if (seg[0] === "viewas" && method === "POST") {
      viewPersona = seg[1] === "member" ? MEMBER_PERSONA : OWNER_PERSONA;
      rerenderAll();
      noopStream(req, res);
      return;
    }

    // Command palette overlay (0 = close).
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

    // Per-todo actions: /todo/<id>/<action>/<arg>
    if (seg[0] === "todo" && method === "POST") {
      const id = Number(seg[1]);
      const action = seg[2];
      const arg = seg[3];
      if (action === "status") await setStatus(ctx, id, arg as Status, actorName());
      else if (action === "priority") await setPriority(ctx, id, arg as Priority, actorName());
      else if (action === "block") await addDependency(ctx, id, Number(arg));
      else if (action === "unblock") await removeDependency(ctx, id, Number(arg));
      rerenderAll(); // refresh boards
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        await sendMenu(stream, id); // refresh the open menu (history streams in)
      });
      return;
    }

    const switchMatch = url.match(/^\/switch\/(\d+)$/);
    if (switchMatch && method === "POST") {
      ctx = await openWorkspace(personaId, Number(switchMatch[1]));
      filter = { ...emptyFilter };
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
        filter = { ...emptyFilter };
        stream.patchSignals(JSON.stringify({ newWs: "" }));
        rerenderAll();
      });
      return;
    }

    if (url === "/add" && method === "POST") {
      const reader = await ServerSentEventGenerator.readSignals(req);
      const s = (reader.success ? reader.signals : {}) as { newTitle?: string; newPriority?: Priority };
      const title = (s.newTitle ?? "").trim();
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        if (!title) {
          stream.patchSignals(JSON.stringify({ error: "Title can't be empty." }));
          return;
        }
        await addTodo(ctx, title, s.newPriority ?? "med", {}, actorName());
        stream.patchSignals(JSON.stringify({ newTitle: "", error: "" }));
        rerenderAll();
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

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("server error");
  }
});

server.listen(PORT, () => {
  console.log(`todo web UI  -> http://localhost:${PORT}`);
  console.log(`stardust     -> ${process.env.STARDUST_URL ?? "http://localhost:1981"}`);
});
