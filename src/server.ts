// Datastar web UI for the Stardust todo app — now workspace-aware.
//
//   node src/server.ts        # http://localhost:3000
//
// One active workspace at a time (single-user tool feel). The persona owns
// several workspaces; the #wsbar switches between them. Switching updates the
// server's current context and closes open streams; Datastar auto-reconnects
// and /stream re-renders the switcher + list against the new workspace.

import http from "node:http";
import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/node";
import { type Priority, addTodo, listTodos, removeTodo, toggleTodo, watchTodos } from "./todos.ts";
import { type WorkspaceCtx, defaultWorkspace, openWorkspace } from "./workspace.ts";
import { createWorkspace, listWorkspaces } from "./tenancy.ts";
import { listFragment, page, wsBar } from "./view.ts";

const PORT = Number(process.env.PORT ?? 3000);

// The default persona and the currently-active workspace context.
let ctx: WorkspaceCtx = await defaultWorkspace();
const personaId = ctx.personaId;

// One inner controller per active stream iteration. On a workspace switch we
// abort them so each stream's loop re-subscribes to the new workspace's reactor
// over the SAME browser connection (no reconnect needed).
const switchControllers = new Set<AbortController>();
const rerenderAll = () => {
  for (const c of switchControllers) c.abort();
};

function noopStream(req: http.IncomingMessage, res: http.ServerResponse) {
  ServerSentEventGenerator.stream(req, res, () => {});
}

const server = http.createServer(async (req, res) => {
  // Datastar sends signals on a GET as ?datastar=... — match on the PATH only,
  // never the full URL, or those requests 404.
  const url = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method ?? "GET";

  try {
    if (url === "/" && method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(await listTodos(ctx)));
      return;
    }

    // Long-lived read stream. Each loop iteration renders the switcher for the
    // current workspace, then streams that workspace's list until a switch
    // aborts the inner controller — then it re-renders for the new workspace.
    if (url === "/stream" && method === "GET") {
      let closed = false;
      let inner: AbortController | null = null;
      req.on("close", () => {
        closed = true;
        inner?.abort();
      });
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        while (!closed) {
          inner = new AbortController();
          switchControllers.add(inner);
          stream.patchElements(wsBar(await listWorkspaces(personaId), ctx.workspaceId));
          await watchTodos(ctx, (todos) => stream.patchElements(listFragment(todos)), inner.signal);
          switchControllers.delete(inner);
        }
      });
      return;
    }

    // Switch active workspace.
    const switchMatch = url.match(/^\/switch\/(\d+)$/);
    if (switchMatch && method === "POST") {
      ctx = await openWorkspace(personaId, Number(switchMatch[1])); // access-checked
      rerenderAll();
      noopStream(req, res);
      return;
    }

    // Create + switch to a new workspace.
    if (url === "/new-workspace" && method === "POST") {
      const reader = await ServerSentEventGenerator.readSignals(req);
      const name = String((reader.success ? (reader.signals as any)?.newWs : "") ?? "").trim();
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        if (!name) return;
        const ws = await createWorkspace(personaId, name);
        ctx = await openWorkspace(personaId, ws.id);
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
      });
      return;
    }

    const toggleMatch = url.match(/^\/toggle\/(\d+)$/);
    if (toggleMatch && method === "POST") {
      await toggleTodo(ctx, Number(toggleMatch[1]));
      noopStream(req, res);
      return;
    }

    const removeMatch = url.match(/^\/remove\/(\d+)$/);
    if (removeMatch && method === "DELETE") {
      await removeTodo(ctx, Number(removeMatch[1]));
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
