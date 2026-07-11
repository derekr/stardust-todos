// Datastar web UI for the Stardust todo app.
//
//   node src/server.ts        # then open http://localhost:3000
//   Env: PORT (default 3000), STARDUST_URL (default http://localhost:1981)
//
// Architecture (CQRS, per the Datastar guidance):
//   - GET /stream      : ONE long-lived SSE per client. Subscribes to the
//                        Stardust reactor and patches #list on every change,
//                        so all connected browsers stay in sync live.
//   - POST /add        : command. Writes a fact, clears the input signal.
//   - POST /toggle/:id  : command. Flips done.
//   - DELETE /remove/:id: command. Retracts the entity.
// Commands don't render the list — the reactor stream does.

import http from "node:http";
import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/node";
import { type Priority, addTodo, listTodos, removeTodo, toggleTodo, watchTodos } from "./todos.ts";
import { type WorkspaceCtx, defaultWorkspace } from "./workspace.ts";
import { listFragment, page } from "./view.ts";

const PORT = Number(process.env.PORT ?? 3000);

// Single default tenant for the web UI (persona switching would swap this ctx).
const ctx: WorkspaceCtx = await defaultWorkspace();

function noopStream(req: http.IncomingMessage, res: http.ServerResponse) {
  ServerSentEventGenerator.stream(req, res, () => {});
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  try {
    // --- Page ---
    if (url === "/" && method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(await listTodos(ctx)));
      return;
    }

    // --- Long-lived read stream: reactor -> Datastar patches ---
    if (url === "/stream" && method === "GET") {
      const ac = new AbortController();
      req.on("close", () => ac.abort());
      ServerSentEventGenerator.stream(req, res, async (stream) => {
        // watchTodos fires immediately with the current list, then on every change.
        await watchTodos(ctx, (todos) => {
          stream.patchElements(listFragment(todos));
        }, ac.signal);
      });
      return;
    }

    // --- Command: add ---
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
        stream.patchSignals(JSON.stringify({ newTitle: "", error: "" })); // clear input
      });
      return;
    }

    // --- Command: toggle ---
    const toggleMatch = url.match(/^\/toggle\/(\d+)$/);
    if (toggleMatch && method === "POST") {
      await toggleTodo(ctx, Number(toggleMatch[1]));
      noopStream(req, res);
      return;
    }

    // --- Command: remove ---
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
