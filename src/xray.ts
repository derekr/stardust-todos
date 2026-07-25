// X-ray mode — an inline "how is this resolved?" overlay. When enabled, every
// data-driven region (anything tagged `data-xray="<key>"`) is outlined; clicking
// one pops a card explaining the Stardust query/derivation behind it, with a real
// code sample and a source pointer. It's the glass box, in situ.
//
// Zero app-state: it's a self-contained overlay (a registry embedded as JSON + a
// small vanilla script) that both the list and detail pages include verbatim.

interface XraySpec {
  title: string;
  mech: string; // one-paragraph explanation
  code: string; // a real, concise snippet
  src: string; // file · function pointer
}

const XRAY: Record<string, XraySpec> = {
  board: {
    title: "The board — ONE canonical reactor",
    mech: "The board is not re-queried per render. A single stored reactor does everything server-side: it reads the session's own facts (viewer, view, tag-active, workspace) plus its `sf` facet children, derives blocked/overdue/effectiveStatus, applies EVERY filter, orders, and projects the finished row. Every browser reads that same reactor through a per-stream bind (?bind={sid …}), so one definition serves all sessions and the client only ever holds a reactor id and its sid — it cannot widen the scope. A session is per BROWSER, so two tabs hold two filters. readSnapshot() is a point-in-time read; the live stream re-emits whenever the RESULT changes — writing a facet, moving the viewer, or a todo field in the top-level `where`. There is no revision counter: the writes are the trigger.",
    code: `// One reactor, parameterized per stream by the session id:
{
  find: ["?t"],
  where: [
    ["?sess", "sid", "?sid"],        // ?sid supplied per-stream via ?bind
    ["?sess", "viewer", "?viewer"], ["?sess", "view", "?view"],
    ["?t", "workspace", "?ws"], ["?t", "status", "?status"], /* … */

    // derive, then filter on the derived value — all in the reactor:
    [["exists", depSub], "?blocked"],
    [["cond", ["and", "?blocked", ["!=", "?status", "done"]],
              "blocked", true, "?status"], "?eff"],
    ["or", ["=", "?draft", false], ["=", "?author", "?viewer"]],
    ["?fs", "facet", "status"], ["?fs", "value", "?eff"],   // value-join
  ],
  orderBy: ["?priority", "?title"],
  then: { project: { id: "?t", effectiveStatus: "?eff",
                     blocked: "?blocked", /* … */ } },
}
// read it:   readResults(reactorId, { sid })     // ?bind={sid 574}
// watch it:  streamResults(reactorId, onRows, signal, { sid })`,
    src: "src/session.ts · canonicalBody() + readSnapshot()",
  },
  counts: {
    title: "Counts — a viewer-scoped tally",
    mech: "aggregateCounts() runs over the viewer-VISIBLE set — the same visibility rule as the board, so a draft you can't see can't leak into the numbers — but deliberately NOT narrowed by the active facets, which is why the chips can show what you'd get if you picked them. It projects {status, priority, blocked} per visible todo; the effective-status tally is a tiny app-side fold (blocked isn't a groupable stored field). It used to be a dry-run replanned on every render; it is now a STORED reactor read with the workspace and viewer supplied as per-read binds, so one reactor serves every workspace.",
    code: `// declared once (src/queries.ts) — ?ws and ?viewer are left unbound:
export const counts = define("board-counts", {
  find: ["?t", "?status", "?priority"],
  where: [
    ["?t", "app", "todo-app"], ["?t", "workspace", "?ws"],
    ["?t", "status", "?status"], ["?t", "priority", "?priority"],
    ...visibleTo("?viewer"),
    [["exists", OPEN_BLOCKER], "?blocked"],   // bind, then project
  ],
  then: { project: { status: "?status", priority: "?priority",
                     blocked: "?blocked" } },
});

// read it, scoped per call — ?bind={ws {# 12} viewer {# 7}}:
await counts.read({ ws: {"#": ctx.workspaceId},
                    viewer: {"#": viewerPersonaId} });
// then tally effectiveStatus(row) + priority app-side`,
    src: "src/queries.ts · counts · src/board.ts · aggregateCounts()",
  },
  blocked: {
    title: "Blocked — derived on read, not stored",
    mech: "There is no stored 'blocked' status — it's a CORRELATED exists over the dependency graph, recomputed on every read. In the board reactor it is BOUND to a variable first: `[[\"exists\", depSub], \"?blocked\"]` makes ?blocked an ordinary per-row boolean that cond/or/and can then use — which is what makes filtering on a DERIVED value possible server-side. (Inlining a bare exists into an expression instead runs it UNCORRELATED, silently true for every row: always bind, then use.) Because it's never materialized it never needs un-writing — finishing a blocker just makes the next read derive false. That is why this app has no background worker.",
    code: `const depSub = {
  capture: { t: "?t" },                 // correlate to the outer row
  find: ["?e"],
  where: [
    ["?e", "kind", "dep"], ["?e", "todo", "?t"],
    ["?e", "blocker", "?b"], ["?b", "status", "?bs"],
    ["!=", "?bs", "done"],              // an OPEN blocker
  ],
};

// bind it, then use it — in the reactor's where clause:
[["exists", depSub], "?blocked"],
[["cond", ["and", "?blocked", ["!=", "?status", "done"]],
          "blocked", true, "?status"], "?eff"],   // done beats blocked`,
    src: "src/session.ts · depSub (board) · src/queries.ts · OPEN_BLOCKER (counts)",
  },
  visibility: {
    title: "Draft visibility — an app predicate, server-side",
    mech: "Stardust does authentication, not authorization — so row-level visibility is an APP predicate: a todo is visible if it's published OR you authored it. ONE definition of that rule (visibleTo) serves every read. On the board the viewer is a FACT on the session; on the counts/options reactors it is a per-read bind. Either way the rule is an expression-`or` over two bound vars, the browser never sends a persona id — it holds only a reactor id and a sid, so it cannot widen the scope — and it stays join-free, paginates, and keeps hidden rows off the wire.",
    code: `// One rule. A "?var" leaves the viewer to a per-read bind (reactors);
// a persona id pins it into the query (one-shot dry-runs).
function visibleTo(viewer) {
  const who = typeof viewer === "number" ? { "#": viewer } : viewer;
  return [
    ["?t", "draft", "?draft"],
    ["?t", "author", "?author"],
    ["or", ["=", "?draft", false], ["=", "?author", who]],
  ];
}

// board reactor — ?viewer comes from the session's own facts:
["?sess", "viewer", "?viewer"], ...visibleTo("?viewer")

// counts / todo-options reactors — supplied at read time:
await counts.read({ ws: {"#": wsId}, viewer: {"#": personaId} });`,
    src: "src/session.ts · canonicalBody() · src/derive.ts · visibleTo() (bound as ?viewer in src/queries.ts)",
  },
  "detail-meta": {
    title: "Metadata — assembled from facts",
    mech: "detailData() composes the detail from facts and small queries: readEntity for the todo, tagsOf for tags, blockerMap for blockers, and a reverse-dependency query for the 'Blocks' row (which todos depend on this one). No joins baked into a table — each field is a fact or a scoped query.",
    code: `// "Blocks" = titles of todos that depend on THIS one (reverse edge),
// declared once and read with the todo bound per call:
export const blockedByTodo = define("todo-blocks", {
  find: ["?bt"],
  where: [
    ["?d", "kind", "dep"],
    ["?d", "blocker", "?todo"],       // this todo is the blocker
    ["?d", "todo", "?t"],
    ["?t", "title", "?bt"],
  ],
  then: { project: { title: "?bt" } },
});

await blockedByTodo.read({ todo: {"#": id} });`,
    src: "src/server.ts · detailData()",
  },
  blockers: {
    title: "Blocked by — a dependency-graph join",
    mech: "blockerMap() runs one join over the workspace's kind:'dep' edges (todo → blocker) and buckets by todo id. Dependencies are real edge ENTITIES, not an inline array on the todo — so adding/removing one is a single fact write, and the graph is directly queryable.",
    code: `export const blockers = define("board-blockers", {
  find: ["?t", "?b", "?bt", "?bs"],
  where: [
    ["?d", "kind", "dep"],
    ["?d", "todo", "?t"],
    ["?t", "workspace", "?ws"],        // bound per read, not baked in
    ["?d", "blocker", "?b"],
    ["?b", "title", "?bt"], ["?b", "status", "?bs"],
  ],
  then: { project: { todo: "?t", blocker: "?b",
                     title: "?bt", status: "?bs" } },
});

await blockers.read({ ws: {"#": ctx.workspaceId} });`,
    src: "src/queries.ts · blockers · src/board.ts · blockerMap()",
  },
  commands: {
    title: "Commands — the role gate is the query",
    mech: 'Every command in this menu is a Stardust ENTITY (kind:"command") carrying its label, the role rank it needs, whether a denied viewer sees it grayed, and its scope. The viewer\'s rank is a BIND, so the gate is a clause: [">=", "?rank", "?minRank"] decides enabled, ["or", "?enabled", "?showWhenDenied"] decides visible, and rows that fail never leave the database. The app does no filtering and holds no visibility flag — this menu reads {scope \'todo\' rank N} and the ⌘K palette reads {scope \'global\' rank N}, same definition. The write boundary (POST /command/<id>) asks a second reactor for that one cmdId at that rank: an EMPTY result is the denial, so the verdict is not re-derived in TypeScript. Granting Teammate the right to archive stays a fact write, not a deploy. Forgetting the rank cannot silently open the gate — ?rank is read by an expression, and an expression cannot invent a variable, so the read fails with \'unbound input var ?rank\' rather than matching every row. That is the opposite of a fact-clause var like ?scope, where an absent bind quietly returns everything.',
    code: `// the menu: Stardust decides what you may SEE
const commandMenu = define("command-menu", {
  find: ["?cmdId", "?label", "?minRank",
         "?enabled", "?danger", "?order"],
  where: [
    ["?c", "kind", "command"],
    ["?c", "scope", "?scope"],            // supplied per read
    ["?c", "minRank", "?minRank"],
    ["?c", "showWhenDenied", "?showWhenDenied"],
    [[">=", "?rank", "?minRank"], "?enabled"],
    [["or", "?enabled", "?showWhenDenied"], "?visible"],
    ["=", "?visible", true],              // invisible rows never return
    /* … cmdId, label, danger, order … */
  ],
  orderBy: ["?order"],
});

// the write boundary: no rows IS the denial
const commandAuthz = define("command-authz", {
  where: [["?c", "cmdId", "?cmdId"],
          ["?c", "minRank", "?minRank"],
          [">=", "?rank", "?minRank"], /* … */],
});

await visibleCommands("todo", role)   // this menu
await authorizeCommand(cmdId, role)   // same rule, on write`,
    src: "src/queries.ts · commandMenu + commandAuthz · src/commands.ts · visibleCommands() + authorizeCommand()",
  },
  activity: {
    title: "Activity — read straight off the fact log",
    mech: "No audit table, and no event replay needed. Every fact carries the transaction that asserted it, so ONE facts read for this entity + field already IS that field's history — a `status` fact only exists because that write actually changed the value. Rows come back newest-first; we reverse to chronological, then attribute each one by reading its transaction ENTITY, where the commit instant and the Tx-Meta headers landed as ordinary facts. (The /inspect page does use bus replay — that's a different mechanism, for the whole log.)",
    code: `// One read. Each row is a value + the tx that asserted it.
const rows = await readFacts({ entityId: id, field: "status" });
//   [{ component: "doing", tx: { "#": 3460 }, entity: { "#": 216 } }, …]

// Attribution + timestamp live ON the transaction entity:
const txe = await readEntity(refId(row.tx));
txe["stardust/committed"]   // {"#utc": "2026-07-24T…"} — commit instant
txe.actor                   // from Tx-Meta-Actor on the write
txe.causationId             // workflow:tx:<N> — what triggered it`,
    src: "src/history.ts · statusHistory()",
  },
  concurrency: {
    title: "The CTA — a guarded transition",
    mech: "This button is a state-machine TRANSITION, so it carries the entity's last transaction (its version) as ?expect. The server makes the write conditional with Tx-Check-Last — a compare-and-swap on that version. If someone moved the todo since you looked, Stardust refuses with 409 and the write is NOT applied; the server patches a toast and the live stream re-paints the truth. The segmented Todo/In Progress/Done control is a deliberate manual override, so it stays unguarded. The version is the same transaction id the Activity timeline shows — no extra bookkeeping.",
    code: `// CTA embeds the entity's last tx at render time (lastTx = newest fact):
@post('/todo/216/status/doing?expect=3456')

// The write is made conditional on it (CAS on the entity version):
patchSchemaEntity(schemaId, id, { status }, { actor }, {
  checkLast: { [id]: expectTx },      // Tx-Check-Last-Type: json
});                                   // Tx-Check-Last: {"216":3456}

// Stardust refuses with 409 and commits NOTHING. The record stream's
// terminal item names the conflict and both versions:
//   {"stardust/error":true, "code":"transaction_conflict",
//    "message":"entity 216 last tx check failed: expected 3456, got 3460",
//    "details":{"entity":"216","expectedTx":3456,"actualTx":3460}}

// The server turns the refusal into a toast + refresh — never a clobber:
if (e instanceof TxConflictError)
  stream.patchSignals({ toast: "Someone changed this task — refreshed to the latest." });`,
    src: "src/stardust.ts · lastTx() + Tx-Check-Last",
  },
};

const SCRIPT = `
(function(){
  var XR = JSON.parse(document.getElementById('xray-data').textContent);
  var pop = document.getElementById('xray-pop');
  var tgl = document.getElementById('xray-toggle');
  var on = false;
  function setOn(v){ on = v; document.body.classList.toggle('xray-on', on); tgl.classList.toggle('on', on); if(!on) pop.hidden = true; }
  tgl.addEventListener('click', function(){ setOn(!on); });
  document.addEventListener('keydown', function(e){
    if(e.altKey && e.key.toLowerCase()==='x'){ e.preventDefault(); setOn(!on); }
    else if(e.key==='Escape'){ pop.hidden = true; }
  });
  document.addEventListener('click', function(e){
    if(!on) return;
    if(e.target===tgl || e.target.closest('#xray-pop')) return;
    var el = e.target.closest('[data-xray]');
    if(el){ e.preventDefault(); e.stopPropagation(); showPop(el.getAttribute('data-xray'), el); }
    else { pop.hidden = true; }
  }, true);
  function row(cls, txt){ var d=document.createElement('div'); d.className=cls; d.textContent=txt; return d; }
  function showPop(key, el){
    var d = XR[key]; if(!d) return;
    pop.innerHTML='';
    var h=document.createElement('div'); h.className='xr-head';
    var t=document.createElement('span'); t.className='xr-title'; t.textContent=d.title; h.appendChild(t);
    var x=document.createElement('button'); x.className='xr-x'; x.textContent='\\u00d7'; x.addEventListener('click',function(){pop.hidden=true;}); h.appendChild(x);
    pop.appendChild(h);
    pop.appendChild(row('xr-mech', d.mech));
    var pre=document.createElement('pre'); pre.className='xr-code'; pre.textContent=d.code; pop.appendChild(pre);
    pop.appendChild(row('xr-src', d.src));
    var r=el.getBoundingClientRect();
    pop.hidden=false;
    var pr=pop.getBoundingClientRect();
    var top=r.bottom+8, left=Math.min(r.left, window.innerWidth-pr.width-12);
    if(top+pr.height > window.innerHeight-12) top = Math.max(12, r.top-pr.height-8);
    pop.style.top = Math.max(12, top)+'px';
    pop.style.left = Math.max(12, left)+'px';
  }
})();
`;

/** Everything x-ray needs, dropped in verbatim before </body> on any page. */
export function xrayAssets(): string {
  const data = JSON.stringify(XRAY).replace(/</g, "\\u003c");
  return `
  <button id="xray-toggle" aria-label="toggle x-ray mode" title="X-ray the data mechanics (⌥X)">⚡ x-ray</button>
  <div id="xray-pop" hidden></div>
  <script type="application/json" id="xray-data">${data}</script>
  <style>
    #xray-toggle{position:fixed;right:14px;bottom:calc(80px + env(safe-area-inset-bottom));z-index:80;
      font-family:var(--mono);font-size:12px;color:var(--muted);background:var(--elev2);
      border:1px solid var(--line);border-radius:999px;padding:7px 13px;cursor:pointer;
      display:flex;gap:5px;align-items:center;box-shadow:0 6px 18px rgba(0,0,0,.4);}
    #xray-toggle.on{color:#1d2021;background:var(--aqua);border-color:var(--aqua);font-weight:600;}
    @media (min-width:900px){ #xray-toggle{bottom:16px;} }
    body.xray-on [data-xray]{outline:1px dashed var(--aqua);outline-offset:3px;border-radius:4px;cursor:help;}
    body.xray-on [data-xray]:hover{background:rgba(142,192,124,.10);}
    #xray-pop{position:fixed;z-index:81;width:min(92vw,430px);max-height:72vh;overflow:auto;
      background:var(--elev);border:1px solid var(--aqua);border-radius:14px;padding:14px;
      box-shadow:0 22px 60px rgba(0,0,0,.6);}
    #xray-pop[hidden]{display:none;}
    .xr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;}
    .xr-title{font-size:14px;font-weight:700;color:var(--aqua);line-height:1.3;}
    .xr-x{border:0;background:transparent;color:var(--muted);font-size:18px;line-height:1;cursor:pointer;padding:0 2px;}
    .xr-mech{font-size:13px;line-height:1.55;color:var(--fg);margin-bottom:10px;}
    .xr-code{font-family:var(--mono);font-size:11.5px;line-height:1.5;color:var(--fg);background:var(--bg);
      border:1px solid var(--line);border-radius:9px;padding:11px;overflow-x:auto;white-space:pre;margin:0 0 8px;}
    .xr-src{font-family:var(--mono);font-size:11px;color:var(--faint);}
  </style>
  <script>${SCRIPT}</script>`;
}
