// detail.ts — Full-screen Gruvbox-dark DETAIL page for the real route /todo/<id>.
// Replaces the old menuFragment overlay. Server-rendered HTML; all interactivity
// is Datastar (server-authoritative). Every action reuses the SAME endpoints the
// old menu used (see server.ts). The page hosts a long-lived per-todo SSE that
// re-patches #detail on every change, so actions just POST and the view reacts.

import type { Todo, Priority, Status } from "./todos.ts";
import type { Blocker } from "./board.ts";
import type { ProjectedCommand } from "./commands.ts";
import { xrayAssets } from "./xray.ts";
import { B } from "./base.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const DATASTAR = "https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js";

export type HistEntry = { status: string; at: string; actor?: string; via?: string };

export interface DetailOpts {
  effStatus: Status; // DERIVED effective status (may be "blocked") — drives the eyebrow
  blockers: Blocker[]; // this todo's blockers (dot + title + unblock)
  candidates: { id: number; title: string }[]; // "add blocker" options
  blocks: string[]; // titles of todos THIS todo blocks (metadata "Blocks" row)
  tags: string[]; // optional tag pills
  history: HistEntry[]; // status-history timeline (Activity)
  commands: ProjectedCommand[]; // role-gated per-todo commands (in the ••• menu)
  canPublish: boolean; // viewer is the draft's author → primary CTA becomes Publish
  note?: string; // NOTES card — omitted entirely when absent
  due?: string; // optional ISO due date — "—" when absent
  expectTx: number; // entity's last tx at render time — the CTA's optimistic-concurrency guard
}

// ---- domain → label/colour maps -----------------------------------------
const STATUS_LABEL: Record<string, string> = {
  todo: "Todo",
  doing: "In Progress",
  blocked: "Blocked",
  done: "Done",
};
const PRIO_LABEL: Record<Priority, string> = { high: "High", med: "Med", low: "Low" };
const PRIOS: Priority[] = ["high", "med", "low"];

// Relative time for the activity timeline (server-side, vs. now).
function rel(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function dueLabel(iso?: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { weekday: "short" }); // e.g. "Fri"
}

// ---- sub-renderers --------------------------------------------------------

function timeline(history: HistEntry[]): string {
  if (!history.length) return `<div class="empty">No activity yet.</div>`;
  return (
    `<div class="timeline">` +
    history
      .map((h) => {
        const who = h.actor
          ? `<span class="tlactor ${h.actor === "workflow" ? "sys" : ""}">${esc(h.actor)}${
              h.via ? ` · via ${esc(h.via)}` : ""
            }</span>`
          : "";
        return `<div class="tl">
          <span class="tldot status-${esc(h.status)}"></span>
          <span class="tlstatus">${esc(STATUS_LABEL[h.status] ?? h.status)}</span>
          ${who}
          <span class="tltime">${esc(rel(h.at))}</span>
        </div>`;
      })
      .join("") +
    `</div>`
  );
}

/** The inner detail content the server can re-patch on every mutation. */
export function detailFragment(todo: Todo, opts: DetailOpts): string {
  const id = todo.id;
  const p = todo.priority;
  const stored = todo.status; // todo | doing | done (never "blocked")
  const eff = opts.effStatus; // may be "blocked"
  const isDone = stored === "done";

  // 2. Eyebrow — priority dot + PRIORITY word (coloured) · effective STATUS.
  const eyebrow = `<div class="eyebrow" data-xray="blocked">
    <span class="dot prio-${p}"></span>
    <span class="prio-${p}">${esc(PRIO_LABEL[p].toUpperCase())}</span>
    <span class="ebdot">·</span>
    <span class="ebstatus">${esc((STATUS_LABEL[eff] ?? eff).toUpperCase())}</span>
  </div>`;

  // 4. Tag pills (optional).
  const tags = opts.tags.length
    ? `<div class="tags">${opts.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>`
    : "";

  // 5. Metadata card. Priority row taps to reveal an inline picker.
  const prioPick = PRIOS.map(
    (pp) =>
      `<button class="ppick ${p === pp ? "on" : ""} prio-${pp}" data-on:click="@post('${B}/todo/${id}/priority/${pp}'); $prioOpen=false">
        <span class="dot prio-${pp}"></span>${esc(PRIO_LABEL[pp])}
      </button>`,
  ).join("");

  const meta = `<div class="card" data-xray="detail-meta">
    <div class="mrow">
      <span class="mlabel">Assignee</span>
      <span class="mval">${esc(todo.lastActor || "You")}</span>
    </div>
    <button class="mrow tap" data-on:click="$prioOpen = !$prioOpen" aria-label="change priority">
      <span class="mlabel">Priority</span>
      <span class="mval"><span class="dot prio-${p}"></span><span class="prio-${p}">${esc(PRIO_LABEL[p])}</span></span>
    </button>
    <div class="priopick" style="display:none" data-show="$prioOpen">${prioPick}</div>
    <div class="mrow">
      <span class="mlabel">Due</span>
      <span class="mval">${esc(dueLabel(opts.due))}</span>
    </div>
    <div class="mrow last">
      <span class="mlabel">Blocks</span>
      <span class="mval muted">${opts.blocks.length ? opts.blocks.map(esc).join(" · ") : "—"}</span>
    </div>
  </div>`;

  // 6. Status control (segmented). Highlights the STORED status.
  const seg = (["todo", "doing", "done"] as const)
    .map(
      (s) =>
        `<button class="segbtn ${stored === s ? "on" : ""}" data-on:click="@post('${B}/todo/${id}/status/${s}')">${esc(
          STATUS_LABEL[s],
        )}</button>`,
    )
    .join("");
  const status = `<div class="seg">${seg}</div>`;

  // 7. NOTES — omitted entirely when there is no note (never faked).
  const notes = opts.note ? `<div class="seclabel">NOTES</div><div class="card notecard">${esc(opts.note)}</div>` : "";

  // 8. BLOCKS / Blocked by.
  const blockerRows = opts.blockers.length
    ? opts.blockers
        .map(
          (b) =>
            `<div class="brow">
              <span class="sdot status-${esc(b.status)}"></span>
              <span class="btitle">${esc(b.title)}</span>
              <button class="unblock" data-on:click="@post('${B}/todo/${id}/unblock/${b.id}')" aria-label="remove blocker">unblock&nbsp;×</button>
            </div>`,
        )
        .join("")
    : `<div class="empty">Nothing blocking this.</div>`;
  const cands = opts.candidates.length
    ? opts.candidates
        .map(
          (c) =>
            `<button class="cand" data-on:click="@post('${B}/todo/${id}/block/${c.id}'); $addOpen=false">
              <span class="sdot"></span>${esc(c.title)}
            </button>`,
        )
        .join("")
    : `<div class="empty">No other todos to depend on.</div>`;
  const blocks = `<div class="seclabel">BLOCKED BY</div>
    <div class="card blockcard" data-xray="blockers">
      ${blockerRows}
      <button class="addblock" data-on:click="$addOpen = !$addOpen">+ Add blocker</button>
      <div class="candlist" style="display:none" data-show="$addOpen">${cands}</div>
    </div>`;

  // 9. Activity timeline.
  const activity = `<div class="seclabel">ACTIVITY</div><div class="card tlcard" data-xray="activity">${timeline(opts.history)}</div>`;

  // 1. ••• actions menu — role-gated per-todo commands. Delete redirects home.
  const cmdItems = opts.commands
    .map((c) => {
      if (!c.enabled)
        return `<button class="amitem denied" disabled>${esc(c.label)}<span class="creason">${esc(c.reason)}</span></button>`;
      const after = c.cmdId === "todo.delete" ? "window.location.href='/'" : "$menuOpen=false";
      return `<button class="amitem ${c.danger ? "danger" : ""}" data-on:click="@post('${B}/command/${c.cmdId}/${id}'); ${after}">${esc(c.label)}</button>`;
    })
    .join("");

  // 10. Bottom action bar. Primary CTA depends on state. Each variant is a
  // state-machine TRANSITION, so it carries `?expect=<tx>` — the entity's last
  // transaction when this view rendered. The server makes the write conditional
  // on it (Tx-Check-Last): if someone moved the todo since, the write is refused
  // and we toast + refresh instead of clobbering. (The segmented status control
  // below is a deliberate manual override, so it stays UNguarded.)
  const guard = `?expect=${opts.expectTx}`;
  let primaryLabel: string;
  let primaryAction: string;
  if (isDone) {
    primaryLabel = "Reopen";
    primaryAction = `@post('${B}/todo/${id}/status/todo${guard}')`;
  } else if (todo.draft && opts.canPublish) {
    primaryLabel = "Publish";
    primaryAction = `@post('${B}/publish/${id}${guard}')`;
  } else if (stored === "doing") {
    primaryLabel = "Done ▸";
    primaryAction = `@post('${B}/todo/${id}/status/done${guard}')`;
  } else {
    primaryLabel = "Start task ▸";
    primaryAction = `@post('${B}/todo/${id}/status/doing${guard}')`;
  }

  return `<div id="detail">
    <div class="nav">
      <a class="navback" href="${B}/">‹ Todos</a>
      <span class="navid">#${id}</span>
      <button class="navmore" data-on:click="$menuOpen = !$menuOpen" aria-label="actions">•••</button>
    </div>
    <div class="mback" style="display:none" data-show="$menuOpen" data-on:click="$menuOpen=false"></div>
    <div class="actionsmenu" style="display:none" data-show="$menuOpen">
      ${cmdItems || `<div class="empty">No actions available.</div>`}
    </div>

    ${eyebrow}
    <h1 class="title">${esc(todo.title)}${todo.draft ? `<span class="draftbadge">draft</span>` : ""}</h1>
    ${tags}
    ${meta}
    ${status}
    ${notes}
    ${blocks}
    ${activity}

    <div class="actionbar">
      <button class="iconsq" data-on:click="@post('${B}/toggle/${id}')" aria-label="toggle done" title="toggle done">⊘</button>
      <button class="primary" data-xray="concurrency" data-on:click="${primaryAction}">${esc(primaryLabel)}</button>
    </div>
  </div>`;
}

// ---- Full page shell ------------------------------------------------------

export function detailPage(todo: Todo, opts: DetailOpts): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(todo.title)} · #${todo.id}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;700&display=swap" rel="stylesheet" />
  <script type="module" src="${DATASTAR}"></script>
  <style>
    :root {
      color-scheme: dark;
      --bg:#1d2021; --elev:#282828; --elev2:#32302f; --line:rgba(168,153,132,.16);
      --fg:#ebdbb2; --fg-bright:#fbf1c7; --muted:#a89984; --faint:#928374;
      --orange:#fe8019; --red:#fb4934; --yellow:#fabd2f; --green:#b8bb26; --purple:#d3869b; --aqua:#8ec07c;
      --sans:'IBM Plex Sans',system-ui,sans-serif; --mono:'IBM Plex Mono',ui-monospace,monospace;
    }
    * { box-sizing:border-box; }
    html,body { background:var(--bg); }
    body { margin:0; color:var(--fg); font-family:var(--sans); -webkit-font-smoothing:antialiased;
           padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom); }
    button { font-family:inherit; cursor:pointer; }

    /* centred content column */
    #detail { max-width:440px; margin:0 auto; padding:8px 20px 108px; position:relative; }

    /* 1. nav bar */
    .nav { display:flex; align-items:center; justify-content:space-between; height:48px; }
    .navback { font-family:var(--mono); font-size:14px; color:var(--orange); text-decoration:none; }
    .navback:active { opacity:.6; }
    .navid { font-family:var(--mono); font-size:13px; color:var(--muted); }
    .navmore { border:0; background:transparent; color:var(--orange); font-size:18px; line-height:1;
               padding:6px 4px; letter-spacing:1px; }
    /* ••• actions menu */
    .mback { position:fixed; inset:0; z-index:20; }
    .actionsmenu { position:absolute; top:46px; right:20px; z-index:21; min-width:180px;
                   background:var(--elev2); border:1px solid var(--line); border-radius:12px;
                   padding:6px; box-shadow:0 16px 48px rgba(0,0,0,.55); display:flex; flex-direction:column; gap:2px; }
    .amitem { display:flex; align-items:center; justify-content:space-between; gap:8px; text-align:left;
              border:0; background:transparent; color:var(--fg); padding:9px 11px; border-radius:8px; font-size:14px; }
    .amitem:hover { background:var(--elev); }
    .amitem.danger { color:var(--red); }
    .amitem.denied { color:var(--faint); opacity:.6; }
    .creason { font-family:var(--mono); font-size:10px; color:var(--faint); text-transform:uppercase; letter-spacing:.03em; }

    /* 2. eyebrow */
    .eyebrow { display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:12px;
               letter-spacing:.06em; margin:10px 0 8px; }
    .ebdot { color:var(--faint); }
    .ebstatus { color:var(--muted); }
    .dot { width:8px; height:8px; border-radius:50%; background:var(--faint); display:inline-block; flex:0 0 auto; }
    .prio-high { color:var(--red); }   .dot.prio-high { background:var(--red); }
    .prio-med  { color:var(--yellow); } .dot.prio-med  { background:var(--yellow); }
    .prio-low  { color:var(--faint); }  .dot.prio-low  { background:var(--faint); }

    /* 3. title */
    .title { font-size:28px; line-height:1.2; font-weight:700; color:var(--fg-bright); margin:0 0 14px; }
    .draftbadge { font-family:var(--mono); font-size:11px; font-weight:500; color:var(--purple);
                  background:rgba(211,134,155,.12); border:1px solid rgba(211,134,155,.28);
                  border-radius:8px; padding:2px 8px; margin-left:10px; vertical-align:middle; letter-spacing:.03em; }

    /* 4. tag pills */
    .tags { display:flex; flex-wrap:wrap; gap:6px; margin:-4px 0 16px; }
    .tag { font-family:var(--mono); font-size:12px; color:var(--muted); background:var(--elev);
           border-radius:8px; padding:4px 9px; }

    /* generic card */
    .card { background:var(--elev); border-radius:14px; overflow:hidden; margin-bottom:18px; }

    /* 5. metadata card */
    .mrow { display:flex; align-items:center; justify-content:space-between; width:100%;
            padding:14px 16px; border-bottom:1px solid var(--line); background:transparent;
            border-left:0; border-right:0; border-top:0; text-align:left; }
    .mrow.last, .mrow:last-child { border-bottom:0; }
    .mrow.tap:active { background:var(--elev2); }
    .mlabel { font-size:14px; color:var(--muted); }
    .mval { display:inline-flex; align-items:center; gap:8px; font-size:14px; color:var(--fg); }
    .mval.muted { color:var(--muted); font-family:var(--mono); font-size:13px; }
    .priopick { display:flex; gap:8px; padding:0 16px 14px; }
    .priopick:not([style*="display: none"]) { border-top:1px solid var(--line); padding-top:14px; }
    .ppick { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line);
             background:var(--elev2); color:var(--fg); border-radius:9px; padding:7px 12px; font-size:13px; }
    .ppick.on { border-color:currentColor; }

    /* 6. status segmented control */
    .seg { display:flex; gap:6px; background:var(--elev); border-radius:12px; padding:5px; margin-bottom:22px; }
    .segbtn { flex:1; border:0; background:transparent; color:var(--muted); font-size:13px; font-weight:500;
              padding:9px 6px; border-radius:9px; }
    .segbtn.on { background:var(--orange); color:#1d2021; font-weight:600; }

    /* section labels */
    .seclabel { font-family:var(--mono); font-size:11px; letter-spacing:.12em; color:var(--faint);
                margin:0 0 8px 2px; }

    /* 7. notes */
    .notecard { padding:14px 16px; font-size:14px; line-height:1.55; color:var(--fg); white-space:pre-wrap; }

    /* 8. blockers */
    .blockcard { padding:6px; }
    .brow { display:flex; align-items:center; gap:10px; padding:10px 10px; }
    .sdot { width:8px; height:8px; border-radius:50%; background:var(--faint); flex:0 0 auto; }
    .sdot.status-doing { background:var(--yellow); }
    .sdot.status-blocked { background:var(--red); }
    .sdot.status-done { background:var(--green); }
    .sdot.status-todo { background:var(--faint); }
    .btitle { flex:1; font-size:14px; color:var(--fg); }
    .unblock { border:0; background:transparent; color:var(--faint); font-family:var(--mono); font-size:12px; padding:4px 6px; }
    .unblock:hover { color:var(--red); }
    .addblock { width:100%; text-align:left; border:0; background:transparent; color:var(--orange);
                font-size:13px; padding:10px; border-top:1px solid var(--line); border-radius:0; }
    .candlist { display:flex; flex-direction:column; gap:2px; padding:4px 0 2px; }
    .cand { display:flex; align-items:center; gap:10px; text-align:left; border:0; background:transparent;
            color:var(--fg); font-size:14px; padding:9px 10px; border-radius:8px; }
    .cand:hover { background:var(--elev2); }

    /* 9. activity timeline */
    .tlcard { padding:14px 16px 14px 18px; }
    .timeline { display:flex; flex-direction:column; border-left:1.5px solid var(--line); margin-left:4px; padding-left:16px; }
    .tl { display:flex; align-items:center; gap:8px; padding:6px 0; position:relative; }
    .tldot { width:9px; height:9px; border-radius:50%; position:absolute; left:-21px; background:var(--faint);
             box-shadow:0 0 0 3px var(--elev); }
    .tldot.status-doing { background:var(--yellow); }
    .tldot.status-blocked { background:var(--red); }
    .tldot.status-done { background:var(--green); }
    .tldot.status-todo { background:var(--faint); }
    .tlstatus { font-size:13px; color:var(--fg); }
    .tlactor { font-size:12px; color:var(--muted); }
    .tlactor.sys { font-family:var(--mono); font-size:11px; color:var(--purple); }
    .tltime { margin-left:auto; font-family:var(--mono); font-size:11px; color:var(--faint); }

    .empty { padding:14px 12px; color:var(--faint); font-size:13px; text-align:center; }

    /* optimistic-concurrency conflict toast */
    .toast { position:fixed; left:50%; bottom:96px; transform:translateX(-50%); max-width:min(92vw,400px);
             font-family:var(--mono); font-size:12.5px; color:var(--fg-bright); background:var(--elev2);
             border:1px solid var(--line); border-radius:10px; padding:9px 14px; z-index:90; cursor:pointer;
             box-shadow:0 12px 30px rgba(0,0,0,.45); }

    /* 10. sticky bottom action bar (bottom of the centred column) */
    .actionbar { position:fixed; left:50%; transform:translateX(-50%); bottom:0; width:100%;
                 max-width:440px; display:flex; gap:12px; align-items:center;
                 padding:14px 20px calc(14px + env(safe-area-inset-bottom));
                 background:linear-gradient(to top, var(--bg) 72%, rgba(29,32,33,0)); }
    .iconsq { width:52px; height:52px; flex:0 0 auto; border:1px solid var(--line); background:var(--elev);
              color:var(--muted); border-radius:12px; font-size:22px; line-height:1; }
    .iconsq:active { background:var(--elev2); }
    .primary { flex:1; height:52px; border:0; border-radius:12px; background:var(--orange);
               color:#1d2021; font-size:16px; font-weight:700; }
    .primary:active { filter:brightness(.92); }

    /* fluid: a comfortable centred column on desktop */
    @media (min-width: 900px) {
      #detail { max-width:600px; padding:20px 28px 120px; }
      .actionbar { max-width:600px; }
      .title { font-size:32px; }
    }
  </style>
</head>
<body data-signals="{menuOpen:false, prioOpen:false, addOpen:false, toast:''}">
  <!-- Outer wrapper holds the long-lived per-todo stream; it re-patches #detail
       on every change. Actions just POST — the stream reflects the new state. -->
  <div id="detailroot" data-init="@get('${B}/todo/${todo.id}/stream', {retryInterval: 300, retryMaxCount: 100000})">
    ${detailFragment(todo, opts)}
  </div>
  <!-- Toast lives OUTSIDE #detail so re-patching the detail never clears it.
       Set by the server on an optimistic-concurrency conflict; tap to dismiss. -->
  <div class="toast" style="display:none" data-show="$toast" data-text="$toast" data-on:click="$toast=''"></div>
  ${xrayAssets()}
</body>
</html>`;
}
