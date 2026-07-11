// Server-rendered HTML. Datastar patches #board, #filterbar, #menu, #wsbar.
// Styling is Linear/shadcn-inspired but self-contained; all interactivity is
// driven by Datastar (server-authoritative), no competing client JS.

import type { Todo, Priority, Status } from "./todos.ts";
import type { Role, Workspace } from "./tenancy.ts";
import type { Filter } from "./board.ts";
import type { Blocker } from "./board.ts";
import type { ProjectedCommand } from "./commands.ts";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const DATASTAR = "https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js";

const STATUS_ORDER: Status[] = ["todo", "doing", "blocked", "done"];
const STATUS_LABEL: Record<Status, string> = { todo: "Todo", doing: "In Progress", blocked: "Blocked", done: "Done" };
const PRIOS: Priority[] = ["high", "med", "low"];

// ---- Workspace switcher --------------------------------------------------

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
      <input type="text" name="newWs" data-bind:new-ws placeholder="+ new workspace" />
    </form>
  </div>`;
}

// ---- Command surfaces (all fed by ONE projected catalog) -----------------

// A global command as a toolbar/palette control. Denied → disabled + reason.
function cmdControl(c: ProjectedCommand, cls: string, extraOnClick = ""): string {
  if (!c.enabled) {
    return `<button class="${cls} denied" disabled title="${esc(c.reason)}">${esc(c.label)}<span class="creason">${esc(c.reason)}</span></button>`;
  }
  return `<button class="${cls} ${c.danger ? "cdanger" : ""}" data-on:click="@post('/command/${c.cmdId}')${extraOnClick}">${esc(c.label)}</button>`;
}

/** Toolbar: role switcher + global commands (surface #1) + palette opener. */
export function toolbar(role: Role | null, globalCmds: ProjectedCommand[]): string {
  const controls = globalCmds.map((c) => cmdControl(c, "cmdbtn")).join("");
  return `<div id="toolbar">
    <span class="flabel">view as</span>
    <button class="rtab ${role === "owner" ? "active" : ""}" data-on:click="@post('/viewas/owner')">Owner</button>
    <button class="rtab ${role === "member" ? "active" : ""}" data-on:click="@post('/viewas/member')">Teammate</button>
    <span class="fsep"></span>
    ${controls}
    <button class="cmdbtn palette" data-on:click="@get('/palette')">Commands <kbd class="kbd">⌘K</kbd></button>
  </div>`;
}

/** Command palette overlay (surface #2) — the same global commands, listed. */
export function palette(globalCmds: ProjectedCommand[]): string {
  const items = globalCmds
    .map((c) =>
      c.enabled
        ? `<button class="palitem ${c.danger ? "cdanger" : ""}" data-on:click="@post('/command/${c.cmdId}'); @get('/palette/0')">${esc(c.label)}</button>`
        : `<button class="palitem denied" disabled>${esc(c.label)}<span class="creason">${esc(c.reason)}</span></button>`,
    )
    .join("");
  return `<div id="palette">
    <div class="backdrop" data-on:click="@get('/palette/0')"></div>
    <div class="palcard">
      <div class="paltitle">Commands</div>
      <div class="palnote">Same catalog as the toolbar. Denied commands are grayed with a reason.</div>
      ${items}
    </div>
  </div>`;
}

// ---- Filter bar (Linear-style) -------------------------------------------

const chip = (label: string, active: boolean, action: string, count?: number) =>
  `<button class="chip ${active ? "active" : ""}" data-on:click="@post('${action}')">${esc(label)}${
    count !== undefined ? `<span class="cnt">${count}</span>` : ""
  }</button>`;

export function filterBar(
  f: Filter,
  statusCounts: Record<string, number>,
  priorityCounts: Record<string, number>,
  tags: string[],
): string {
  const views = (["all", "ready", "overdue"] as const)
    .map((v) => chip(v[0].toUpperCase() + v.slice(1), f.view === v, `/filter/view/${v}`))
    .join("");
  const statuses = STATUS_ORDER.map((s) =>
    chip(STATUS_LABEL[s], f.status.includes(s), `/filter/status/${s}`, statusCounts[s] ?? 0),
  ).join("");
  const prios = PRIOS.map((p) => chip(p, f.priority.includes(p), `/filter/priority/${p}`, priorityCounts[p] ?? 0)).join("");
  const tagChips = tags.length
    ? `<span class="fsep"></span><span class="flabel">tag</span>` +
      tags.map((t) => chip(t, f.tags.includes(t), `/filter/tag/${encodeURIComponent(t)}`)).join("")
    : "";
  const groups = (["status", "priority", "none"] as const)
    .map((g) => chip(g, f.group === g, `/filter/group/${g}`))
    .join("");

  return `<div id="filterbar">
    <div class="frow">
      <span class="flabel">view</span>${views}
      <span class="fsep"></span><span class="flabel">status</span>${statuses}
      <span class="fsep"></span><span class="flabel">priority</span>${prios}
      ${tagChips}
    </div>
    <div class="frow frow2">
      <span class="flabel">group by</span>${groups}
    </div>
  </div>`;
}

// ---- Board (grouped, filtered) -------------------------------------------

function row(t: Todo, blockers: Blocker[]): string {
  const open = blockers.filter((b) => b.status !== "done");
  const blockedBy = open.length
    ? `<span class="blockedby">⛔ ${open.map((b) => `<span class="bchip">${esc(b.title)}</span>`).join("")}</span>`
    : "";
  return `<li id="todo-${t.id}" class="row ${t.done ? "done" : ""} ${t.status === "blocked" ? "blockedrow" : ""}">
    <button class="check ${t.done ? "checked" : ""}" role="checkbox" aria-checked="${t.done}"
            aria-label="toggle ${esc(t.title)}" ${t.status === "blocked" ? "disabled" : ""}
            data-on:click="@post('/toggle/${t.id}')">${t.done ? "✓" : ""}</button>
    <span class="prio prio-${t.priority}">${t.priority}</span>
    <span class="title">${esc(t.title)}</span>
    ${blockedBy}
    ${t.status && t.status !== "todo" ? `<span class="status status-${t.status}">${STATUS_LABEL[t.status]}</span>` : ""}
    <button class="iconbtn" aria-label="actions for ${esc(t.title)}" data-on:click="@get('/menu/${t.id}')">⋯</button>
    <button class="iconbtn del" aria-label="delete ${esc(t.title)}" data-on:click="@delete('/remove/${t.id}')">×</button>
  </li>`;
}

export function boardFragment(todos: Todo[], blockers: Map<number, Blocker[]>, f: Filter): string {
  const bl = (id: number) => blockers.get(id) ?? [];
  const section = (label: string, items: Todo[]) =>
    items.length
      ? `<div class="group"><div class="ghead">${esc(label)}<span class="gcount">${items.length}</span></div>
         <ul class="glist">${items.map((t) => row(t, bl(t.id))).join("")}</ul></div>`
      : "";

  let body = "";
  if (f.group === "status") {
    body = STATUS_ORDER.map((s) => section(STATUS_LABEL[s], todos.filter((t) => t.status === s))).join("");
  } else if (f.group === "priority") {
    body = PRIOS.map((p) => section(p.toUpperCase(), todos.filter((t) => t.priority === p))).join("");
  } else {
    body = `<ul class="glist">${todos.map((t) => row(t, bl(t.id))).join("")}</ul>`;
  }
  if (!todos.length) body = `<div class="empty">No todos match this filter.</div>`;

  return `<div id="board">
    ${body}
    <div class="boardfoot">${todos.length} shown</div>
  </div>`;
}

// ---- Action menu (Datastar-driven overlay) -------------------------------

function historyTimeline(history: { status: string; at: string }[]): string {
  if (!history.length) return `<div class="mnote">no changes yet</div>`;
  const fmt = (iso: string) => iso.replace("T", " ").replace(/\..*/, "").slice(5, 16); // MM-DD HH:MM
  return (
    `<div class="timeline">` +
    history
      .map(
        (h) =>
          `<div class="tl"><span class="tldot status-${h.status}"></span><span class="tlstatus">${
            STATUS_LABEL[h.status as Status] ?? h.status
          }</span><span class="tltime">${fmt(h.at)}</span></div>`,
      )
      .join("") +
    `</div>`
  );
}

export function menuFragment(
  todo: Todo | null,
  blockers: Blocker[],
  candidates: { id: number; title: string }[],
  history: { status: string; at: string }[] = [],
  todoCommands: ProjectedCommand[] = [],
): string {
  if (!todo) return `<div id="menu"></div>`;
  const cmdItems = todoCommands
    .map((c) =>
      c.enabled
        ? `<button class="mitem ${c.danger ? "cdanger" : ""}" data-on:click="@post('/command/${c.cmdId}/${todo.id}'); @get('/menu/0')">${esc(c.label)}</button>`
        : `<button class="mitem denied" disabled>${esc(c.label)}<span class="creason">${esc(c.reason)}</span></button>`,
    )
    .join("");
  const statusBtns = (["todo", "doing", "done"] as const)
    .map(
      (s) =>
        `<button class="mitem ${todo.status === s ? "on" : ""}" data-on:click="@post('/todo/${todo.id}/status/${s}')">${STATUS_LABEL[s]}</button>`,
    )
    .join("");
  const prioBtns = PRIOS.map(
    (p) =>
      `<button class="mitem ${todo.priority === p ? "on" : ""}" data-on:click="@post('/todo/${todo.id}/priority/${p}')">${p}</button>`,
  ).join("");
  const current = blockers.length
    ? blockers
        .map(
          (b) =>
            `<div class="brow"><span>${esc(b.title)}</span><button class="xmini" data-on:click="@post('/todo/${todo.id}/unblock/${b.id}')">×</button></div>`,
        )
        .join("")
    : `<div class="mnote">none</div>`;
  const addOpts = candidates.length
    ? candidates
        .map(
          (c) =>
            `<button class="mitem" data-on:click="@post('/todo/${todo.id}/block/${c.id}')">+ ${esc(c.title)}</button>`,
        )
        .join("")
    : `<div class="mnote">no other todos</div>`;

  return `<div id="menu">
    <div class="backdrop" data-on:click="@get('/menu/0')"></div>
    <div class="menucard">
      <div class="mtitle">${esc(todo.title)}</div>
      <div class="msec"><div class="mlabel">Status</div><div class="mrow">${statusBtns}</div></div>
      <div class="msec"><div class="mlabel">Priority</div><div class="mrow">${prioBtns}</div></div>
      <div class="msec"><div class="mlabel">Blocked by</div>${current}</div>
      <div class="msec"><div class="mlabel">Add blocker</div><div class="mcol">${addOpts}</div></div>
      <div class="msec"><div class="mlabel">Activity — status history</div>${historyTimeline(history)}</div>
      <div class="msec"><div class="mlabel">Commands (role-gated, same catalog)</div><div class="mcol">${cmdItems}</div></div>
      <button class="mclose" data-on:click="@get('/menu/0')">Close</button>
    </div>
  </div>`;
}

// ---- Page shell ----------------------------------------------------------

export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Todos · Stardust + Datastar</title>
  <script type="module" src="${DATASTAR}"></script>
  <style>
    :root { color-scheme: light dark; --bg:#0b0d10; --card:#14171c; --card2:#1a1e25; --fg:#e8e8ea; --mut:#8b93a1; --line:#242a33; --accent:#6c7bff; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    .wrap { max-width:760px; margin:5vh auto; padding:0 20px; }
    h1 { font-size:20px; margin:0 0 2px; }
    .sub { color:var(--mut); margin:0 0 18px; font-size:12px; }
    #wsbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:14px; }
    .wslabel,.flabel { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--mut); }
    .wstab { border:1px solid var(--line); background:var(--card); color:var(--fg); padding:4px 11px; border-radius:20px; cursor:pointer; font-size:13px; }
    .wstab.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .wsnew input { border:1px dashed var(--line); background:transparent; color:var(--fg); padding:4px 10px; border-radius:20px; font-size:13px; width:130px; }
    form.add { display:flex; gap:8px; margin-bottom:14px; }
    input[type=text].maintext { flex:1; padding:9px 12px; border:1px solid var(--line); border-radius:9px; background:var(--card); color:var(--fg); font-size:14px; }
    select { padding:0 10px; border:1px solid var(--line); border-radius:9px; background:var(--card); color:var(--fg); }
    button.add { padding:9px 16px; border:0; border-radius:9px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }
    /* filter bar */
    #filterbar { border:1px solid var(--line); border-radius:11px; padding:9px 11px; margin-bottom:12px; background:var(--card); }
    .frow { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
    .frow2 { margin-top:8px; padding-top:8px; border-top:1px solid var(--line); }
    .fsep { width:1px; height:16px; background:var(--line); margin:0 5px; }
    .chip { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:var(--card2); color:var(--mut); padding:3px 9px; border-radius:7px; cursor:pointer; font-size:12.5px; }
    .chip:hover { color:var(--fg); }
    .chip.active { background:var(--accent); border-color:var(--accent); color:#fff; }
    .chip .cnt { font-size:11px; opacity:.75; }
    .chip.active .cnt { opacity:.9; }
    /* board */
    .group { margin-bottom:12px; }
    .ghead { display:flex; align-items:center; gap:8px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--mut); padding:2px 4px 6px; }
    .gcount { background:var(--card2); border-radius:20px; padding:0 7px; font-size:11px; }
    .glist { list-style:none; margin:0; padding:0; background:var(--card); border:1px solid var(--line); border-radius:11px; overflow:hidden; }
    .row { display:flex; align-items:center; gap:9px; padding:9px 12px; border-top:1px solid var(--line); }
    .row:first-child { border-top:0; }
    .check { width:19px; height:19px; flex:0 0 auto; border:1.5px solid var(--mut); border-radius:6px; background:transparent; color:#fff; cursor:pointer; font-size:12px; display:flex; align-items:center; justify-content:center; padding:0; }
    .check.checked { background:var(--accent); border-color:var(--accent); }
    .check:disabled { cursor:not-allowed; opacity:.4; }
    .title { flex:1; }
    .done .title { text-decoration:line-through; color:var(--mut); }
    .prio { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; padding:2px 7px; border-radius:20px; border:1px solid var(--line); color:var(--mut); flex:0 0 auto; }
    .prio-high { color:#f2555a; border-color:#f2555a55; }
    .prio-med { color:#f5a623; border-color:#f5a62355; }
    .status { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; padding:2px 8px; border-radius:20px; font-weight:600; flex:0 0 auto; }
    .status-blocked { color:#f2555a; background:#f2555a1a; }
    .status-doing { color:#6c7bff; background:#6c7bff1a; }
    .status-done { color:#35b37e; background:#35b37e1a; }
    .blockedrow { opacity:.7; }
    .blockedby { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:#f2555a; }
    .bchip { background:#f2555a1a; border-radius:5px; padding:1px 6px; }
    .iconbtn { border:0; background:transparent; color:var(--mut); font-size:17px; line-height:1; cursor:pointer; padding:0 4px; flex:0 0 auto; }
    .iconbtn:hover { color:var(--fg); }
    .iconbtn.del:hover { color:#f2555a; }
    .empty,.mnote { padding:18px 14px; color:var(--mut); text-align:center; font-size:13px; }
    .mnote { padding:4px; text-align:left; }
    .boardfoot { color:var(--mut); font-size:11px; padding:8px 4px 0; }
    .err { color:#f2555a; font-size:13px; min-height:18px; margin:-6px 0 10px; }
    .live { display:inline-flex; align-items:center; gap:6px; }
    .dot { width:7px; height:7px; border-radius:50%; background:#35b37e; }
    /* menu overlay */
    .backdrop { position:fixed; inset:0; background:rgba(0,0,0,.5); }
    .menucard { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:340px; max-width:92vw; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; box-shadow:0 20px 60px rgba(0,0,0,.5); }
    .mtitle { font-weight:600; margin-bottom:12px; font-size:15px; }
    .msec { margin-bottom:11px; }
    .mlabel { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--mut); margin-bottom:5px; }
    .mrow { display:flex; gap:6px; flex-wrap:wrap; }
    .mcol { display:flex; flex-direction:column; gap:4px; max-height:160px; overflow:auto; }
    .mitem { text-align:left; border:1px solid var(--line); background:var(--card2); color:var(--fg); padding:5px 10px; border-radius:7px; cursor:pointer; font-size:13px; }
    .mitem.on { background:var(--accent); border-color:var(--accent); color:#fff; }
    .brow { display:flex; align-items:center; justify-content:space-between; padding:3px 0; }
    .xmini { border:0; background:transparent; color:#f2555a; cursor:pointer; font-size:16px; }
    .mdanger { width:100%; border:1px solid #f2555a55; background:transparent; color:#f2555a; padding:7px; border-radius:8px; cursor:pointer; }
    .mclose { width:100%; margin-top:6px; border:1px solid var(--line); background:var(--card2); color:var(--fg); padding:7px; border-radius:8px; cursor:pointer; }
    .timeline { display:flex; flex-direction:column; gap:0; border-left:1.5px solid var(--line); margin-left:5px; padding-left:12px; }
    .tl { display:flex; align-items:center; gap:8px; padding:3px 0; position:relative; }
    .tldot { width:9px; height:9px; border-radius:50%; position:absolute; left:-17px; background:var(--mut); }
    .tldot.status-blocked { background:#f2555a; } .tldot.status-doing { background:#6c7bff; } .tldot.status-done { background:#35b37e; } .tldot.status-todo { background:var(--mut); }
    .tlstatus { font-size:12.5px; }
    .tltime { font-size:11px; color:var(--faint); font-family:var(--mono); margin-left:auto; }
    /* command surfaces */
    #toolbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:12px; }
    .rtab { border:1px solid var(--line); background:var(--card2); color:var(--mut); padding:3px 11px; border-radius:7px; cursor:pointer; font-size:12.5px; }
    .rtab.active { background:var(--accent); border-color:var(--accent); color:#fff; }
    .cmdbtn { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); padding:4px 11px; border-radius:8px; cursor:pointer; font-size:12.5px; }
    .cmdbtn:hover:not(:disabled) { border-color:var(--accent); }
    .cmdbtn.palette { margin-left:auto; color:var(--mut); }
    .cmdbtn.cdanger:hover:not(:disabled), .mitem.cdanger:hover:not(:disabled), .palitem.cdanger:hover:not(:disabled) { border-color:#f2555a; color:#f2555a; }
    .denied { opacity:.5; cursor:not-allowed; }
    .creason { font-size:10px; color:var(--faint); margin-left:6px; text-transform:uppercase; letter-spacing:.03em; }
    #palette:empty { display:none; }
    .palcard { position:fixed; top:14vh; left:50%; transform:translateX(-50%); width:420px; max-width:92vw; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; box-shadow:0 20px 60px rgba(0,0,0,.5); display:flex; flex-direction:column; gap:5px; z-index:10; }
    .paltitle { font-weight:600; font-size:15px; }
    .palnote { color:var(--mut); font-size:12px; margin-bottom:6px; }
    .palitem { text-align:left; border:1px solid var(--line); background:var(--card2); color:var(--fg); padding:9px 12px; border-radius:9px; cursor:pointer; font-size:14px; display:flex; align-items:center; }
    .palitem:hover:not(:disabled) { border-color:var(--accent); }
    .mitem.denied, .palitem.denied { justify-content:space-between; }
    .kbd { font-family:var(--mono); font-size:10px; border:1px solid var(--line); border-radius:4px; padding:0 4px; margin-left:5px; color:var(--faint); }
  </style>
</head>
<body data-signals="{newTitle: '', newPriority: 'med', newWs: '', error: '', toast: ''}">
  <div class="wrap">
    <h1>Todos</h1>
    <p class="sub"><span class="live"><span class="dot"></span>live</span> · Stardust facts · reactor stream · Datastar · filtered & aggregated by query</p>

    <div id="wsbar"></div>
    <div id="toolbar"></div>
    <div class="err" data-text="$toast"></div>

    <form class="add" data-on:submit__prevent="@post('/add')">
      <input type="text" class="maintext" name="newTitle" data-bind:new-title placeholder="What needs doing?" autofocus />
      <select name="newPriority" data-bind:new-priority>
        <option value="high">high</option>
        <option value="med">med</option>
        <option value="low">low</option>
      </select>
      <button class="add">Add</button>
    </form>
    <div class="err" data-text="$error"></div>

    <div id="filterbar"></div>

    <!-- Long-lived read stream drives #filterbar + #board for the active
         workspace + filter; re-subscribes in place on switch/filter change. -->
    <div data-init="@get('/stream', {retryInterval: 300, retryMaxCount: 100000})">
      <div id="board"></div>
    </div>

    <div id="menu"></div>
    <div id="palette"></div>
  </div>
  <script>
    // Keyboard shortcut shim: Cmd/Ctrl+K opens the palette, Escape closes it.
    // It just triggers the same Datastar-wired controls — no client state.
    addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.querySelector(".cmdbtn.palette")?.click();
      } else if (e.key === "Escape") {
        document.querySelector("#palette .backdrop")?.click();
      }
    });
  </script>
</body>
</html>`;
}
