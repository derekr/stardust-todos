// Datastar web UI: workspace-aware, with Linear-style filtering/grouping/
// aggregates (all powered by Stardust queries) and a dependency action menu.
//
//   node src/server.ts        # http://localhost:3000

import http from "node:http";
import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/node";
import { type Priority, type Status, addTodo, removeTodo, setPriority, setStatus, toggleTodo } from "./todos.ts";
import { type WorkspaceCtx, defaultWorkspace, openWorkspace } from "./workspace.ts";
import { createWorkspace, listWorkspaces } from "./tenancy.ts";
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
import { boardFragment, filterBar, menuFragment, page, wsBar } from "./view.ts";

const PORT = Number(process.env.PORT ?? 3000);

let ctx: WorkspaceCtx = await defaultWorkspace();
const personaId = ctx.personaId;
let filter: Filter = { ...emptyFilter };

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
  const history = await statusHistory(id);
  return menuFragment(todo, blockers, candidates, history);
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
          await watchTodos(ctx, () => void renderBoard(stream), inner.signal);
          switchControllers.delete(inner);
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
        stream.patchElements(await menuElements(id));
      });
      return;
    }

    // Per-todo actions: /todo/<id>/<action>/<arg>
    if (seg[0] === "todo" && method === "POST") {
      const id = Number(seg[1]);
      const action = seg[2];
      const arg = seg[3];
      if (action === "status") await setStatus(ctx, id, arg as Status);
      else if (action === "priority") await setPriority(ctx, id, arg as Priority);
      else if (action === "block") await addDependency(ctx, id, Number(arg));
      else if (action === "unblock") await removeDependency(ctx, id, Number(arg));
      rerenderAll(); // refresh boards
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        stream.patchElements(await menuElements(id)); // refresh the open menu
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
        await addTodo(ctx, title, s.newPriority ?? "med");
        stream.patchSignals(JSON.stringify({ newTitle: "", error: "" }));
        rerenderAll();
      });
      return;
    }

    const toggleMatch = url.match(/^\/toggle\/(\d+)$/);
    if (toggleMatch && method === "POST") {
      await toggleTodo(ctx, Number(toggleMatch[1]));
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
