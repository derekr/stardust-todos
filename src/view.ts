// Server-rendered HTML. Datastar patches the #list fragment over SSE.

import type { Todo } from "./todos.ts";
import type { Workspace } from "./tenancy.ts";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Workspace switcher. Patched by /stream so every client stays in sync. */
export function wsBar(workspaces: Workspace[], activeId: number): string {
  const tabs = workspaces
    .map(
      (w) =>
        `<button class="wstab ${w.id === activeId ? "active" : ""}" data-on:click="@post('/switch/${w.id}')">${esc(w.name)}</button>`,
    )
    .join("");
  return `<div id="wsbar">
    <span class="wslabel">workspace</span>
    ${tabs}
    <form class="wsnew" data-on:submit__prevent="@post('/new-workspace')">
      <input type="text" data-bind:newWs placeholder="+ new workspace" />
    </form>
  </div>`;
}

const DATASTAR = "https://cdn.jsdelivr.net/gh/starfederation/datastar@1.0.0/bundles/datastar.js";

/** The live-updated list. Stable id (#list) so Datastar can morph it. */
export function listFragment(todos: Todo[]): string {
  const open = todos.filter((t) => !t.done).length;
  const rows = todos.length
    ? todos
        .map(
          (t) => `
      <li class="row ${t.done ? "done" : ""}">
        <input type="checkbox" ${t.done ? "checked" : ""}
               aria-label="toggle ${esc(t.title)}"
               data-on:change="@post('/toggle/${t.id}')" />
        <span class="prio prio-${t.priority}">${t.priority}</span>
        <span class="title">${esc(t.title)}</span>
        <button class="del" aria-label="delete ${esc(t.title)}"
                data-on:click="@delete('/remove/${t.id}')">×</button>
      </li>`,
        )
        .join("")
    : `<li class="empty">Nothing yet. Add your first todo above.</li>`;

  return `<ul id="list">
    ${rows}
    <li class="count">${open} open · ${todos.length} total</li>
  </ul>`;
}

export function page(todos: Todo[]): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Todos · Stardust + Datastar</title>
  <script type="module" src="${DATASTAR}"></script>
  <style>
    :root { color-scheme: light dark; --bg:#fafafa; --card:#fff; --fg:#1a1a1a; --mut:#888; --line:#e6e6e6; --accent:#4f46e5; }
    @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --fg:#e8e8ea; --mut:#7c8391; --line:#262a33; --accent:#7c83ff; } }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    .wrap { max-width:560px; margin:6vh auto; padding:0 20px; }
    h1 { font-size:22px; margin:0 0 4px; }
    .sub { color:var(--mut); margin:0 0 22px; font-size:13px; }
    form { display:flex; gap:8px; margin-bottom:18px; }
    input[type=text] { flex:1; padding:10px 12px; border:1px solid var(--line); border-radius:9px; background:var(--card); color:var(--fg); font-size:15px; }
    select { padding:0 10px; border:1px solid var(--line); border-radius:9px; background:var(--card); color:var(--fg); }
    button.add { padding:10px 16px; border:0; border-radius:9px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }
    ul { list-style:none; margin:0; padding:0; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
    .row { display:flex; align-items:center; gap:10px; padding:11px 14px; border-top:1px solid var(--line); }
    .row:first-child { border-top:0; }
    .row input[type=checkbox] { width:18px; height:18px; accent-color:var(--accent); cursor:pointer; }
    .title { flex:1; }
    .done .title { text-decoration:line-through; color:var(--mut); }
    .prio { font-size:11px; text-transform:uppercase; letter-spacing:.04em; padding:2px 7px; border-radius:20px; border:1px solid var(--line); color:var(--mut); }
    .prio-high { color:#e5484d; border-color:#e5484d55; }
    .prio-med { color:#f5a623; border-color:#f5a62355; }
    .del { border:0; background:transparent; color:var(--mut); font-size:20px; line-height:1; cursor:pointer; padding:0 4px; }
    .del:hover { color:#e5484d; }
    .empty { padding:22px 14px; color:var(--mut); text-align:center; border-top:0; }
    .count { padding:9px 14px; border-top:1px solid var(--line); color:var(--mut); font-size:12px; }
    .err { color:#e5484d; font-size:13px; min-height:18px; margin:-8px 0 12px; }
    #wsbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:14px; }
    .wslabel { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--mut); margin-right:2px; }
    .wstab { border:1px solid var(--line); background:var(--card); color:var(--fg); padding:5px 11px; border-radius:20px; cursor:pointer; font-size:13px; }
    .wstab.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .wsnew input { border:1px dashed var(--line); background:transparent; color:var(--fg); padding:5px 10px; border-radius:20px; font-size:13px; width:130px; }
    .live { display:inline-flex; align-items:center; gap:6px; }
    .dot { width:7px; height:7px; border-radius:50%; background:#30c46f; box-shadow:0 0 0 0 #30c46f88; animation:pulse 2s infinite; }
    @keyframes pulse { 0%{box-shadow:0 0 0 0 #30c46f88} 70%{box-shadow:0 0 0 6px #30c46f00} 100%{box-shadow:0 0 0 0 #30c46f00} }
  </style>
</head>
<body data-signals="{newTitle: '', newPriority: 'med', newWs: '', error: ''}">
  <div class="wrap">
    <h1>Todos</h1>
    <p class="sub"><span class="live"><span class="dot"></span>live</span> · backed by Stardust facts, streamed through a reactor, rendered by Datastar</p>

    <!-- Workspace switcher; filled + kept in sync by /stream. -->
    <div id="wsbar"></div>

    <form data-on:submit__prevent="@post('/add')">
      <input type="text" data-bind:newTitle placeholder="What needs doing?" autofocus />
      <select data-bind:newPriority>
        <option value="high">high</option>
        <option value="med">med</option>
        <option value="low">low</option>
      </select>
      <button class="add">Add</button>
    </form>
    <div class="err" data-text="$error"></div>

    <!-- Long-lived read stream (CQRS): the active workspace's reactor drives
         every client's list. Switching workspaces closes streams; Datastar
         auto-reconnects here and re-renders against the new workspace. -->
    <div data-on-load="@get('/stream', {retryInterval: 300, retryMaxCount: 100000})">
      ${listFragment(todos)}
    </div>
  </div>
</body>
</html>`;
}
