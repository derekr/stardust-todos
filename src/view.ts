// Server-rendered HTML for the HOME/LIST screen — Gruvbox-dark mobile design.
// Datastar (v1.0.2) patches #board, #filterbar (and the two count spans) over
// the long-lived /stream SSE. All colors derive from the :root tokens.

import type { Todo, Priority, Status } from "./todos.ts";
import type { Filter } from "./board.ts";
import type { Blocker } from "./board.ts";
import { effectiveStatus } from "./board.ts";
import type { ProjectedCommand } from "./commands.ts";
import { xrayAssets } from "./xray.ts";
import { readFileSync } from "node:fs";
import { B } from "./base.ts";

// Vendored (scripts/vendor-assets.sh) — a CDN here sits in front of the stream
// that carries the page's content, so it gates first render.
const DATASTAR = `${B}/static/datastar.js`;

// Preload tags for the latin faces, generated alongside the fonts so no hashed
// filename is ever hard-coded here. Missing file = no preloads, not a crash.
const FONT_PRELOADS = (() => {
  try {
    return readFileSync(new URL("../public/fonts-preload.html", import.meta.url), "utf8")
      .replaceAll("__BASE__", B)
      .trim();
  } catch {
    return "";
  }
})();

/** Minimal HTML escaper for any user-authored text (titles, tags, blockers). */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Design groups the board by effectiveStatus in this fixed order; only
// non-empty groups render. "blocked" is DERIVED (effectiveStatus), never stored.
const STATUS_ORDER: Status[] = ["todo", "doing", "blocked", "done"];
const GROUP_LABEL: Record<Status, string> = {
  todo: "TODO",
  doing: "IN PROGRESS",
  blocked: "BLOCKED",
  done: "DONE",
};
const STATUS_LABEL: Record<Status, string> = { todo: "Todo", doing: "In Progress", blocked: "Blocked", done: "Done" };
const PRIOS: Priority[] = ["high", "med", "low"];

// ---- Inline icons (self-contained; no external icon font needed) ---------
const svg = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  list: svg(
    `<circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/>`,
  ),
  grid: svg(
    `<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>`,
  ),
  clock: svg(`<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>`),
  contrast: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 3 a9 9 0 0 1 0 18 z" fill="currentColor" stroke="none"/>`),
  sliders: svg(
    `<line x1="4" y1="8" x2="20" y2="8"/><circle cx="9" cy="8" r="2.4" fill="var(--bg)"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="15" cy="16" r="2.4" fill="var(--bg)"/>`,
  ),
  check: `<svg class="ck" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l2.8 2.8L12.5 5"/></svg>`,
};

// ---- Filter bar ----------------------------------------------------------
// Primary row = the four VIEW chips from the design (all/ready/overdue/mine).
// Secondary facets (status/priority/tag/group) live in a collapsible row behind
// the sliders toggle so every endpoint stays reachable without clutter.

const viewChip = (label: string, active: boolean, view: string, count?: number) =>
  `<button class="vchip ${active ? "on" : ""}" data-on:click="@post('${B}/filter/view/${view}')">${esc(label)}${
    count !== undefined ? `<span class="vc-n">·${count}</span>` : ""
  }</button>`;

const facetChip = (label: string, active: boolean, action: string, count?: number) =>
  `<button class="fchip ${active ? "on" : ""}" data-on:click="@post('${B}${action}')">${esc(label)}${
    count !== undefined ? `<span class="fc-n">${count}</span>` : ""
  }</button>`;

/** The two count spans live in the title pill and are morphed there by id. */
const cnum = (id: string, n: number) => `<span id="${id}" class="cnum">${n}</span>`;

/** "all·N" — N is the total shown (sum of the viewer-scoped status counts). */
export const visibleTotal = (statusCounts: Record<string, number>): number =>
  Object.values(statusCounts).reduce((a, b) => a + b, 0);

/** The filter bar element on its own — shared by the SSE patch and the SSR shell. */
export function filterBarEl(
  f: Filter,
  statusCounts: Record<string, number>,
  priorityCounts: Record<string, number>,
  tags: string[],
): string {
  const total = visibleTotal(statusCounts);

  const views =
    viewChip("all", f.view === "all", "all", total) +
    viewChip("ready", f.view === "ready", "ready") +
    viewChip("overdue", f.view === "overdue", "overdue") +
    viewChip("mine", f.view === "mine", "mine");

  const statuses = STATUS_ORDER.map((s) =>
    facetChip(STATUS_LABEL[s], f.status.includes(s), `/filter/status/${s}`, statusCounts[s] ?? 0),
  ).join("");
  const prios = PRIOS.map((p) =>
    facetChip(p, f.priority.includes(p), `/filter/priority/${p}`, priorityCounts[p] ?? 0),
  ).join("");
  const tagChips = tags
    .map((t) => facetChip(`#${t}`, f.tags.includes(t), `/filter/tag/${encodeURIComponent(t)}`))
    .join("");
  const groups = (["status", "priority", "none"] as const)
    .map((g) => facetChip(g, f.group === g, `/filter/group/${g}`))
    .join("");

  return `<div id="filterbar">
    <div class="chiprow">
      ${views}
      <button class="morebtn ${f.status.length || f.priority.length || f.tags.length ? "dirty" : ""}"
              aria-label="more filters" data-on:click="$moreFilters = !$moreFilters"
              data-attr:aria-expanded="$moreFilters ? 'true' : 'false'">${ICON.sliders}</button>
    </div>
    <div class="facets" style="display:none" data-show="$moreFilters">
      <div class="facetgrp"><span class="flabel">status</span>${statuses}</div>
      <div class="facetgrp"><span class="flabel">priority</span>${prios}</div>
      ${tags.length ? `<div class="facetgrp"><span class="flabel">tag</span>${tagChips}</div>` : ""}
      <div class="facetgrp"><span class="flabel">group</span>${groups}</div>
    </div>
  </div>`;
}

/**
 * The SSE payload: the filter bar plus the grand total, emitted as a top-level
 * span that Datastar morphs into the title pill by id. boardFragment owns
 * count-visible the same way.
 */
export function filterBar(
  f: Filter,
  statusCounts: Record<string, number>,
  priorityCounts: Record<string, number>,
  tags: string[],
): string {
  return `${filterBarEl(f, statusCounts, priorityCounts, tags)}
  ${cnum("count-total", visibleTotal(statusCounts))}`;
}

// ---- Board (grouped by effectiveStatus) ----------------------------------

function row(t: Todo, blockers: Blocker[]): string {
  const eff = effectiveStatus(t); // "blocked" is derived, not stored
  const isBlocked = eff === "blocked";
  const firstBlocker = blockers.find((b) => b.status !== "done"); // show the first OPEN blocker
  return `<a href="${B}/todo/${t.id}" class="row ${t.done ? "done" : ""} ${isBlocked ? "blocked" : ""}">
    <button class="cb ${t.done ? "on" : ""}" role="checkbox" aria-checked="${t.done}"
            aria-label="toggle ${esc(t.title)}" ${isBlocked ? "disabled" : ""}
            data-on:click__stop__prevent="@post('${B}/toggle/${t.id}')">${t.done ? ICON.check : ""}</button>
    <span class="pdot p-${t.priority}" aria-hidden="true"></span>
    <span class="rmain">
      <span class="rtitle">${esc(t.title)}</span>
      ${isBlocked && firstBlocker ? `<span class="rsub" data-xray="blocked">⊘ ${esc(firstBlocker.title)}</span>` : ""}
    </span>
    <span class="rmeta">
      ${t.draft ? `<span class="draft" data-xray="visibility">DRAFT</span>` : ""}
      <span class="rid">#${t.id}</span>
      <span class="chev" aria-hidden="true">›</span>
    </span>
  </a>`;
}

/** The board element on its own — shared by the SSE patch and the SSR shell. */
export function boardEl(todos: Todo[], blockers: Map<number, Blocker[]>, f: Filter): string {
  const bl = (id: number) => blockers.get(id) ?? [];
  const rows = (items: Todo[]) => items.map((t) => row(t, bl(t.id))).join("");

  const section = (label: string, items: Todo[]) =>
    items.length
      ? `<section class="group">
           <div class="ghead">${esc(label)}<span class="gcount">${items.length}</span></div>
           <div class="rows">${rows(items)}</div>
         </section>`
      : "";

  let body = "";
  if (!todos.length) {
    body = `<div class="empty"><div class="empty-i">✓</div>Nothing here yet.<span>Tap + to add a task.</span></div>`;
  } else if (f.group === "priority") {
    body = PRIOS.map((p) =>
      section(
        p.toUpperCase(),
        todos.filter((t) => t.priority === p),
      ),
    ).join("");
  } else if (f.group === "none") {
    body = `<section class="group"><div class="rows">${rows(todos)}</div></section>`;
  } else {
    // DEFAULT (design): group by effectiveStatus, fixed order, non-empty only.
    body = STATUS_ORDER.map((s) =>
      section(
        GROUP_LABEL[s],
        todos.filter((t) => effectiveStatus(t) === s),
      ),
    ).join("");
  }

  return `<div id="board" data-xray="board">${body}</div>`;
}

/** The SSE payload: the board plus count-visible, morphed into the title pill. */
export function boardFragment(todos: Todo[], blockers: Map<number, Blocker[]>, f: Filter): string {
  return `${boardEl(todos, blockers, f)}
  ${cnum("count-visible", todos.length)}`;
}

// ---- Command palette (⌘K) + view-as (RBAC identity) ----------------------

/** The "view as" persona toggle — RBAC demo. Lives in the You sheet (mobile)
 *  and the sidebar footer (desktop); $viewAs mirrors the active persona. */
function viewAsControl(): string {
  return `<div class="vaseg">
    <button class="vabtn on" data-class="{on: $viewAs === 'owner'}" data-on:click="$viewAs = 'owner'; @post('${B}/viewas/owner')">Owner</button>
    <button class="vabtn" data-class="{on: $viewAs === 'member'}" data-on:click="$viewAs = 'member'; @post('${B}/viewas/member')">Teammate</button>
  </div>`;
}

/** Command palette overlay (⌘K) — role-gated global commands, patched into #palette. */
export function palette(globalCmds: ProjectedCommand[]): string {
  const items = globalCmds
    .map((c) =>
      c.enabled
        ? `<button class="pal-item ${c.danger ? "danger" : ""}" data-on:click="@post('${B}/command/${c.cmdId}'); @get('${B}/palette/0')">${esc(c.label)}</button>`
        : `<button class="pal-item denied" disabled>${esc(c.label)}<span class="pal-reason">${esc(c.reason)}</span></button>`,
    )
    .join("");
  return `<div id="palette">
    <div class="pal-scrim" data-on:click="@get('${B}/palette/0')"></div>
    <div class="pal-card">
      <div class="pal-head">Commands<kbd>⌘K</kbd></div>
      ${items || `<div class="pal-empty">No commands available.</div>`}
    </div>
  </div>`;
}

// ---- Desktop sidebar (shown ≥900px; reuses the same filter endpoints) ----

const sbView = (label: string, active: boolean, view: string, count?: number) =>
  `<button class="sb-item ${active ? "on" : ""}" data-on:click="@post('${B}/filter/view/${view}')">
    <span class="sb-txt">${esc(label)}</span>${count !== undefined ? `<span class="sb-n">${count}</span>` : ""}
  </button>`;

const sbStatus = (s: Status, active: boolean, count: number) =>
  `<button class="sb-item ${active ? "on" : ""}" data-on:click="@post('${B}/filter/status/${s}')">
    <span class="sb-dot p-${s === "blocked" ? "high" : s === "doing" ? "med" : s === "done" ? "done" : "low"}"></span>
    <span class="sb-txt">${esc(STATUS_LABEL[s])}</span><span class="sb-n">${count}</span>
  </button>`;

export function sidebar(f: Filter, statusCounts: Record<string, number>): string {
  const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  return `<aside id="sidebar">
    <div class="sb-brand">Todos<span class="sb-ws">· Default</span></div>
    <button class="sb-add" data-on:click="$addOpen = true; $error = ''">＋ New task</button>
    <nav class="sb-nav">
      <div class="sb-label">views</div>
      ${sbView("All", f.view === "all", "all", total)}
      ${sbView("Ready", f.view === "ready", "ready")}
      ${sbView("Overdue", f.view === "overdue", "overdue")}
      ${sbView("Mine", f.view === "mine", "mine")}
      <div class="sb-label">status</div>
      ${STATUS_ORDER.map((s) => sbStatus(s, f.status.includes(s), statusCounts[s] ?? 0)).join("")}
    </nav>
    <div class="sb-foot">
      <div class="sb-valabel">view as</div>
      ${viewAsControl()}
      <div class="sb-live"><span class="livedot"></span>live · reactor stream</div>
    </div>
  </aside>`;
}

// ---- Page shell ----------------------------------------------------------

/**
 * The board, already rendered, for the initial HTML. Without it the shell paints
 * empty and the first SSE patch fills it in — a visible flash on any connection
 * slower than the datastar + stream round trip. Datastar morphs over identical
 * markup on connect, so the same builders produce both.
 */
export interface BoardView {
  sidebar: string;
  filterbar: string;
  board: string;
  visible: number;
  total: number;
}

export function page(view?: BoardView): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Todos</title>
  ${FONT_PRELOADS}
  <link rel="stylesheet" href="${B}/static/fonts.css" />
  <script type="module" src="${DATASTAR}"></script>
  <style>
    :root{
      --bg:#1d2021; --elev:#282828; --elev2:#32302f; --line:rgba(168,153,132,.16);
      --fg:#ebdbb2; --fg-bright:#fbf1c7; --muted:#a89984; --faint:#928374;
      --orange:#fe8019; --red:#fb4934; --yellow:#fabd2f; --green:#b8bb26; --purple:#d3869b; --aqua:#8ec07c;
      --sans:'IBM Plex Sans',system-ui,sans-serif; --mono:'IBM Plex Mono',ui-monospace,monospace;
      color-scheme:dark;
    }
    *{box-sizing:border-box;}
    html,body{margin:0;}
    body{background:var(--bg);color:var(--fg);font-family:var(--sans);
      -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
    /* server patches these but the mobile home hides them (wiring stays intact) */
    #wsbar,#toolbar{display:none!important;}

    .app{width:100%;min-height:100vh;padding:22px 18px calc(112px + env(safe-area-inset-bottom));
      position:relative;}

    /* 1 — status / live row */
    .liverow{display:flex;align-items:center;justify-content:space-between;font-size:12px;}
    .live{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);color:var(--muted);}
    .livedot{width:7px;height:7px;border-radius:50%;background:var(--green);
      box-shadow:0 0 0 3px rgba(184,187,38,.16);}
    .liveright{display:flex;align-items:center;gap:11px;}
    .cmdk{font-family:var(--mono);color:var(--orange);font-size:15px;line-height:1;}
    .avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;
      font-family:var(--mono);font-weight:600;font-size:13px;color:#1d2021;
      background:linear-gradient(140deg,var(--orange),var(--red));}

    /* 2 — big title row */
    .titlerow{display:flex;align-items:baseline;justify-content:space-between;margin:16px 0 14px;}
    .apptitle{font-size:32px;font-weight:700;letter-spacing:-.02em;color:var(--fg-bright);margin:0;line-height:1;}
    .countpill{font-family:var(--mono);font-size:13px;color:var(--muted);letter-spacing:.02em;}
    .countpill .ctdot{margin:0 4px;color:var(--faint);}
    .cnum{font-family:var(--mono);}

    /* 3 — search */
    .search{width:100%;border:0;border-radius:12px;background:var(--elev);color:var(--fg);
      font-family:var(--mono);font-size:14px;padding:12px 14px;margin-bottom:14px;outline:none;}
    .search::placeholder{color:var(--faint);}
    .search:focus{box-shadow:inset 0 0 0 1px var(--line);}

    /* 4 — filter chips */
    #filterbar{margin-bottom:6px;}
    .chiprow{display:flex;align-items:center;gap:8px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px;}
    .chiprow::-webkit-scrollbar{display:none;}
    .vchip{flex:0 0 auto;font-family:var(--mono);font-size:12.5px;color:var(--muted);
      background:transparent;border:1px solid var(--line);border-radius:999px;padding:6px 13px;cursor:pointer;
      transition:color .12s,border-color .12s,background .12s;}
    .vchip:hover{color:var(--fg);}
    .vchip.on{color:var(--orange);background:rgba(254,128,25,.16);border-color:rgba(254,128,25,.4);}
    .vc-n{opacity:.8;margin-left:2px;}
    .morebtn{flex:0 0 auto;margin-left:auto;width:32px;height:32px;display:grid;place-items:center;
      border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);cursor:pointer;}
    .morebtn svg{width:16px;height:16px;}
    .morebtn.dirty{color:var(--orange);border-color:rgba(254,128,25,.4);}

    .facets{margin-top:10px;display:flex;flex-direction:column;gap:9px;
      background:var(--elev);border:1px solid var(--line);border-radius:12px;padding:11px 12px;}
    .facetgrp{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
    .flabel{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.12em;
      color:var(--faint);margin-right:2px;min-width:52px;}
    .fchip{font-family:var(--mono);font-size:11.5px;color:var(--muted);background:var(--elev2);
      border:1px solid var(--line);border-radius:999px;padding:3px 9px;cursor:pointer;display:inline-flex;gap:5px;}
    .fchip.on{color:var(--orange);background:rgba(254,128,25,.16);border-color:rgba(254,128,25,.4);}
    .fc-n{opacity:.65;}

    /* 5 — group sections */
    .group{margin-top:18px;}
    .ghead{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;font-weight:600;
      text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin:0 2px 4px;}
    .gcount{color:var(--faint);font-weight:500;}
    .rows{display:flex;flex-direction:column;}

    /* 6 — rows (edge-to-edge, hairline divider, no card) */
    .row{display:flex;align-items:center;gap:12px;padding:13px 2px;text-decoration:none;color:inherit;
      border-top:1px solid var(--line);}
    .rows > .row:first-child{border-top:0;}
    .row:active{background:rgba(168,153,132,.05);}
    .cb{flex:0 0 auto;width:18px;height:18px;border:1.5px solid var(--faint);border-radius:6px;
      background:transparent;padding:0;cursor:pointer;display:grid;place-items:center;color:#1d2021;
      transition:background .12s,border-color .12s;}
    .cb .ck{width:12px;height:12px;}
    .cb.on{background:var(--orange);border-color:var(--orange);}
    .cb:disabled{opacity:.35;cursor:not-allowed;}
    .pdot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--faint);}
    .p-high{background:var(--red);}
    .p-med{background:var(--yellow);}
    .p-low{background:var(--faint);}
    .rmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
    .rtitle{font-size:15px;color:var(--fg);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .row.done .rtitle{text-decoration:line-through;color:var(--faint);}
    .rsub{font-family:var(--mono);font-size:11px;color:var(--red);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .rmeta{flex:0 0 auto;display:flex;align-items:center;gap:8px;}
    .draft{font-family:var(--mono);font-size:10px;letter-spacing:.06em;color:var(--purple);
      border:1px solid rgba(211,134,155,.4);border-radius:999px;padding:1px 7px;}
    .rid{font-family:var(--mono);font-size:11px;color:var(--faint);}
    .chev{color:var(--faint);font-size:18px;line-height:1;}

    .empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:64px 20px;color:var(--muted);}
    .empty-i{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-size:20px;
      color:var(--green);background:rgba(184,187,38,.12);margin-bottom:4px;}
    .empty span{font-family:var(--mono);font-size:12px;color:var(--faint);}

    /* toast / error */
    .toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);max-width:400px;
      font-family:var(--mono);font-size:12.5px;color:var(--fg-bright);background:var(--elev2);
      border:1px solid var(--line);border-radius:10px;padding:9px 14px;z-index:40;
      box-shadow:0 12px 30px rgba(0,0,0,.45);}

    /* 7 — bottom tab bar + FAB */
    .tabbar{position:fixed;left:0;right:0;bottom:0;
      height:calc(64px + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);
      display:grid;grid-template-columns:repeat(5,1fr);align-items:center;
      background:rgba(29,32,33,.86);backdrop-filter:blur(14px);border-top:1px solid var(--line);z-index:30;}
    .tab{display:flex;flex-direction:column;align-items:center;gap:4px;background:transparent;border:0;
      color:var(--muted);font-family:var(--mono);font-size:10px;cursor:pointer;text-decoration:none;padding:0;}
    .tab svg{width:22px;height:22px;}
    .tab.on{color:var(--orange);}
    .fabslot{position:relative;}
    .fab{position:absolute;left:50%;top:50%;transform:translate(-50%,-70%);width:52px;height:52px;border-radius:50%;
      background:var(--orange);color:#1d2021;border:4px solid var(--bg);display:grid;place-items:center;cursor:pointer;
      box-shadow:0 8px 22px rgba(254,128,25,.4);}
    .fab svg{width:26px;height:26px;stroke-width:2.6;}

    /* add sheet (FAB target) */
    .sheet-scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:50;}
    .sheet{position:fixed;left:50%;bottom:0;transform:translateX(-50%);width:100%;max-width:440px;z-index:51;
      background:var(--elev);border-top-left-radius:18px;border-top-right-radius:18px;
      border-top:1px solid var(--line);padding:16px 18px calc(20px + env(safe-area-inset-bottom));
      box-shadow:0 -14px 40px rgba(0,0,0,.5);}
    .sheet-grab{width:38px;height:4px;border-radius:2px;background:var(--faint);opacity:.5;margin:0 auto 14px;}
    .sheet h2{font-size:15px;font-weight:700;color:var(--fg-bright);margin:0 0 12px;}
    .sheet-title{width:100%;border:0;border-radius:11px;background:var(--elev2);color:var(--fg);
      font-family:var(--sans);font-size:16px;padding:13px 14px;outline:none;}
    .sheet-title:focus{box-shadow:inset 0 0 0 1px var(--line);}
    .sheet-row{display:flex;align-items:center;gap:10px;margin-top:12px;}
    .prio-seg{display:flex;gap:6px;flex:1;}
    .prio-seg label{flex:1;position:relative;}
    .prio-seg input{position:absolute;opacity:0;pointer-events:none;}
    .prio-seg span{display:block;text-align:center;font-family:var(--mono);font-size:12.5px;color:var(--muted);
      background:var(--elev2);border:1px solid var(--line);border-radius:999px;padding:7px 0;cursor:pointer;}
    .prio-seg input:checked + span{color:var(--orange);background:rgba(254,128,25,.16);border-color:rgba(254,128,25,.4);}
    .draftbox{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:12.5px;color:var(--muted);cursor:pointer;}
    .draftbox input{accent-color:var(--purple);width:16px;height:16px;}
    .sheet-actions{display:flex;gap:10px;margin-top:16px;}
    .btn-add{flex:1;border:0;border-radius:12px;background:var(--orange);color:#1d2021;font-weight:700;
      font-size:15px;padding:13px;cursor:pointer;font-family:var(--sans);}
    .btn-cancel{border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--muted);
      font-size:14px;padding:13px 18px;cursor:pointer;font-family:var(--sans);}
    .sheet-err{color:var(--red);font-family:var(--mono);font-size:12px;min-height:15px;margin-top:8px;}
    .p-done{background:var(--green);}

    /* ---- Desktop sidebar (hidden on mobile) ---- */
    #sidebar{display:none;}
    .sb-brand{font-size:19px;font-weight:700;color:var(--fg-bright);margin-bottom:16px;}
    .sb-ws{font-family:var(--mono);font-size:12px;font-weight:400;color:var(--faint);margin-left:6px;}
    .sb-add{width:100%;border:0;border-radius:10px;background:var(--orange);color:#1d2021;font-weight:700;
      font-size:13.5px;padding:10px;cursor:pointer;font-family:var(--sans);margin-bottom:20px;}
    .sb-nav{display:flex;flex-direction:column;gap:2px;flex:1;overflow-y:auto;}
    .sb-label{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;
      color:var(--faint);margin:16px 0 6px 6px;}
    .sb-label:first-child{margin-top:0;}
    .sb-item{display:flex;align-items:center;gap:9px;width:100%;text-align:left;border:0;background:transparent;
      color:var(--muted);border-radius:9px;padding:8px 10px;cursor:pointer;font-family:var(--sans);font-size:14px;}
    .sb-item:hover{background:var(--elev);color:var(--fg);}
    .sb-item.on{background:rgba(254,128,25,.12);color:var(--orange);}
    .sb-dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:0 0 auto;}
    .sb-txt{flex:1;}
    .sb-n{font-family:var(--mono);font-size:12px;color:var(--faint);}
    .sb-item.on .sb-n{color:var(--orange);}
    .sb-foot{padding-top:16px;border-top:1px solid var(--line);margin-top:8px;}
    .sb-valabel{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:var(--faint);margin-bottom:8px;}
    .sb-live{font-family:var(--mono);font-size:11px;color:var(--faint);display:flex;align-items:center;gap:8px;margin-top:12px;}

    /* ⌘ + avatar are buttons now */
    .cmdk{border:0;background:transparent;padding:0;cursor:pointer;}
    .avatar{border:0;cursor:pointer;}

    /* view-as segmented (RBAC identity toggle) */
    .vaseg{display:flex;gap:6px;}
    .vabtn{flex:1;border:1px solid var(--line);background:var(--elev2);color:var(--muted);border-radius:10px;
      padding:9px;font-family:var(--sans);font-size:13.5px;font-weight:500;cursor:pointer;}
    .vabtn.on{background:var(--orange);border-color:var(--orange);color:#1d2021;font-weight:700;}

    /* views / you sheet helpers */
    .sh-label{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;
      color:var(--faint);margin:16px 0 8px 2px;}
    .sh-grid{display:flex;flex-wrap:wrap;gap:8px;}
    .sh-grid button{border:1px solid var(--line);background:var(--elev2);color:var(--fg);border-radius:999px;
      padding:8px 15px;font-family:var(--mono);font-size:13px;cursor:pointer;}
    .sh-grid button:hover{border-color:var(--orange);color:var(--orange);}
    .you-sub{font-size:13px;line-height:1.55;color:var(--muted);margin-bottom:4px;}

    /* command palette (⌘K) */
    #palette:empty{display:none;}
    .pal-scrim{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:60;}
    .pal-card{position:fixed;top:14vh;left:50%;transform:translateX(-50%);width:min(92vw,460px);z-index:61;
      background:var(--elev);border:1px solid var(--line);border-radius:16px;padding:10px;
      box-shadow:0 24px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:3px;}
    .pal-head{display:flex;align-items:center;justify-content:space-between;font-family:var(--mono);font-size:11px;
      text-transform:uppercase;letter-spacing:.12em;color:var(--faint);padding:6px 10px 8px;}
    .pal-head kbd{font-family:var(--mono);font-size:10px;border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:var(--muted);}
    .pal-item{display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;border:0;
      background:transparent;color:var(--fg);border-radius:10px;padding:11px 12px;font-size:15px;cursor:pointer;font-family:var(--sans);}
    .pal-item:hover:not(:disabled){background:var(--elev2);}
    .pal-item.danger{color:var(--red);}
    .pal-item.denied{color:var(--faint);opacity:.6;cursor:not-allowed;}
    .pal-reason{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:var(--faint);}
    .pal-empty{padding:14px;color:var(--faint);font-size:13px;text-align:center;}

    /* ---- Fluid: two-pane on desktop ---- */
    @media (min-width: 900px){
      .app{max-width:none;margin:0;padding:26px clamp(24px,4vw,64px) 40px;flex:1;min-width:0;}
      .shell{display:flex;align-items:stretch;min-height:100vh;width:100%;}
      #sidebar{display:flex;flex-direction:column;width:clamp(220px,20vw,300px);flex:0 0 auto;
        padding:26px 18px;border-right:1px solid var(--line);position:sticky;top:0;height:100vh;}
      /* the desktop sidebar replaces the mobile chrome */
      .liverow, .search, #filterbar, .tabbar{display:none!important;}
      .titlerow{margin-top:0;}
      .apptitle{font-size:26px;}
      .toast{left:auto;right:32px;transform:none;}
    }
  </style>
</head>
<!-- Signals: existing app signals (newTitle/newPriority/newDraft/error/toast)
     plus search (visual) + addOpen (FAB sheet) + moreFilters (facet reveal). -->
<body data-signals="{newTitle:'', newPriority:'med', newDraft:false, error:'', toast:'', search:'', addOpen:false, moreFilters:false, viewAs:'owner', youOpen:false, viewsOpen:false}">
  <div class="shell">
  <!-- desktop-only sidebar (server patches it; hidden < 900px) -->
  ${view ? view.sidebar : `<aside id="sidebar"></aside>`}
  <main class="app">
    <!-- 1. live row -->
    <div class="liverow">
      <span class="live"><span class="livedot"></span>live</span>
      <span class="liveright"><button class="cmdk" data-on:click="@get('${B}/palette')" aria-label="commands (⌘K)">⌘</button><button class="avatar" data-on:click="$youOpen = true" aria-label="you">D</button></span>
    </div>

    <!-- 2. title + visible·total (both spans morphed by SSE) -->
    <div class="titlerow">
      <h1 class="apptitle">Todos</h1>
      <span class="countpill" data-xray="counts">${cnum("count-visible", view?.visible ?? 0)}<span class="ctdot">·</span>${cnum("count-total", view?.total ?? 0)}</span>
    </div>

    <!-- 3. search (visual only — bound to $search, no endpoint yet) -->
    <input class="search" data-bind:search placeholder="⌕ Search tasks" aria-label="search tasks" />

    <!-- 4. filter chips -->
    ${view ? view.filterbar : `<div id="filterbar"></div>`}

    <!-- 5/6. long-lived read stream drives #filterbar + #board -->
    <div data-init="@get('${B}/stream', {retryInterval: 300, retryMaxCount: 100000})">
      ${view ? view.board : `<div id="board"></div>`}
    </div>

    <div class="toast" style="display:none" data-text="$toast" data-show="$toast"></div>

    <!-- demo: copy-paste curl commands for THIS session (patched by /stream) -->

    <!-- kept so existing SSE patches have targets -->
    <div id="wsbar"></div>
    <div id="toolbar"></div>
    <div id="menu"></div>
    <div id="palette"></div>
  </main>
  </div>

  <!-- 7. bottom tab bar + raised FAB -->
  <nav class="tabbar" aria-label="primary">
    <a class="tab on" href="${B}/">${ICON.list}todos</a>
    <button class="tab" type="button" data-on:click="$viewsOpen = true">${ICON.grid}views</button>
    <span class="fabslot">
      <button class="fab" type="button" aria-label="add task" data-on:click="$addOpen = true; $error = ''">
        ${svg(`<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`)}
      </button>
    </span>
    <button class="tab" type="button" data-on:click="@post('${B}/filter/view/done')">${ICON.clock}done</button>
    <button class="tab" type="button" data-on:click="$youOpen = true">${ICON.contrast}you</button>
  </nav>

  <!-- add sheet: FAB reveals it; submit posts to existing /add (newTitle/newPriority/newDraft) -->
  <div class="sheet-scrim" style="display:none" data-show="$addOpen" data-on:click="$addOpen = false"></div>
  <div class="sheet" style="display:none" data-show="$addOpen">
    <div class="sheet-grab"></div>
    <h2>New task</h2>
    <form data-on:submit__prevent="@post('${B}/add'); $addOpen = false">
      <input class="sheet-title" type="text" name="newTitle" data-bind:new-title placeholder="What needs doing?" autofocus />
      <div class="sheet-row">
        <div class="prio-seg">
          <label><input type="radio" name="newPriority" value="high" data-bind:new-priority /><span>high</span></label>
          <label><input type="radio" name="newPriority" value="med" data-bind:new-priority /><span>med</span></label>
          <label><input type="radio" name="newPriority" value="low" data-bind:new-priority /><span>low</span></label>
        </div>
        <label class="draftbox" title="A draft is visible only to you"><input type="checkbox" data-bind:new-draft /> draft</label>
      </div>
      <div class="sheet-err" data-text="$error"></div>
      <div class="sheet-actions">
        <button class="btn-cancel" type="button" data-on:click="$addOpen = false">Cancel</button>
        <button class="btn-add" type="submit">Add task</button>
      </div>
    </form>
  </div>

  <!-- "views" tab: derived views + grouping -->
  <div class="sheet-scrim" style="display:none" data-show="$viewsOpen" data-on:click="$viewsOpen = false"></div>
  <div class="sheet" style="display:none" data-show="$viewsOpen">
    <div class="sheet-grab"></div>
    <h2>Views</h2>
    <div class="sh-label">show</div>
    <div class="sh-grid">
      <button data-on:click="@post('${B}/filter/view/all'); $viewsOpen = false">All</button>
      <button data-on:click="@post('${B}/filter/view/ready'); $viewsOpen = false">Ready</button>
      <button data-on:click="@post('${B}/filter/view/overdue'); $viewsOpen = false">Overdue</button>
      <button data-on:click="@post('${B}/filter/view/mine'); $viewsOpen = false">Mine</button>
      <button data-on:click="@post('${B}/filter/view/done'); $viewsOpen = false">Done</button>
    </div>
    <div class="sh-label">group by</div>
    <div class="sh-grid">
      <button data-on:click="@post('${B}/filter/group/status'); $viewsOpen = false">Status</button>
      <button data-on:click="@post('${B}/filter/group/priority'); $viewsOpen = false">Priority</button>
      <button data-on:click="@post('${B}/filter/group/none'); $viewsOpen = false">None</button>
    </div>
  </div>

  <!-- "you" tab / avatar: the RBAC "view as" toggle -->
  <div class="sheet-scrim" style="display:none" data-show="$youOpen" data-on:click="$youOpen = false"></div>
  <div class="sheet" style="display:none" data-show="$youOpen">
    <div class="sheet-grab"></div>
    <h2>You</h2>
    <div class="you-sub">Preview the board as a different persona. A draft is visible only to its author, so switching changes what you can see — and the commands you're allowed to run.</div>
    <div class="sh-label">view as</div>
    ${viewAsControl()}
  </div>

  <!-- command palette target (⌘K / the ⌘ button patch /palette here) -->
  <script>
    addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.querySelector(".cmdk")?.click();
      } else if (e.key === "Escape") {
        document.querySelector("#palette .pal-scrim")?.click();
      }
    });
  </script>
  ${xrayAssets()}
</body>
</html>`;
}

export { esc };
