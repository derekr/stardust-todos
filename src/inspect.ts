// The "glass box" — a standalone /inspect page that shows the REAL Stardust
// machinery behind every interaction. Nothing here is simulated: each panel
// decodes what actually crosses the wire.
//
//   Live feed    subscribe to the commit bus (/events/bus/.../transactions).
//                Each event carries the entity deltas (before→after per field),
//                the asserted/retracted/unchanged counts, and — read off the
//                transaction entity itself — the actor + causationId.
//   Provenance   replay the bus filtered to one entity (Last-Event-ID: 1) and
//                rebuild every field's history: value, the tx that set it, who,
//                when. Temporal facts, straight from the substrate.
//   Replay       replay the whole log from the start and scrub through it — the
//                board's history, event-sourced, played back for real.

import { type EntityId, readEntity, streamRecords } from "./stardust.ts";
import type { RequestRecord } from "./timing.ts";
import { B } from "./base.ts";

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// Decoding: raw bus event -> an app-facing view. Values may be scalars, refs
// ({"#":n}), instants ({"#utc":...}) or ints ({"#i64":"64"}).
// ---------------------------------------------------------------------------
function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#" in o) return `→#${o["#"]}`; // ref
    if ("#utc" in o) return String(o["#utc"]).replace("T", " ").replace(/\..*/, ""); // instant
    if ("#i64" in o) return String(o["#i64"]); // int
    return JSON.stringify(o);
  }
  return String(v);
}

interface FieldChange {
  field: string;
  from: string | null; // null = newly asserted
  to: string | null; // null = retracted
}
interface EntityDelta {
  entity: EntityId;
  label: string;
  changes: FieldChange[];
}
export interface TxView {
  tx: number;
  at: string;
  asserted: number;
  retracted: number;
  unchanged: number;
  actor?: string;
  causation?: string;
  deltas: EntityDelta[];
}

/** Decode one bus event; returns null for a system/bootstrap tx (no app facts). */
function decodeEvent(ev: any): TxView | null {
  const tx = ev?.transaction?.["#"];
  if (!tx) return null;
  const patched: Record<string, any> = ev.patched ?? {};
  const deltas: EntityDelta[] = [];
  for (const [eidStr, ba] of Object.entries(patched)) {
    const eid = Number(eidStr);
    if (eid === tx) continue; // the transaction's own entity — used for attribution below
    const before: Record<string, unknown> = ba?.before ?? {};
    const after: Record<string, unknown> = ba?.after ?? {};
    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changes: FieldChange[] = [];
    for (const f of fields) {
      if (f.startsWith("stardust/")) continue; // engine-internal facts
      const from = f in before ? fmtVal(before[f]) : null;
      const to = f in after ? fmtVal(after[f]) : null;
      if (from === to) continue;
      changes.push({ field: f, from, to });
    }
    if (!changes.length) continue;
    const lbl = after.title ?? before.title ?? after.kind ?? before.kind;
    deltas.push({ entity: eid, label: lbl ? String(lbl) : `#${eid}`, changes });
  }
  if (!deltas.length) return null;
  const txFacts: Record<string, unknown> = patched[String(tx)]?.after ?? {};
  return {
    tx,
    at: ev.committed ?? "",
    asserted: ev.asserted ?? 0,
    retracted: ev.retracted ?? 0,
    unchanged: ev.unchanged ?? 0,
    actor: txFacts.actor as string | undefined,
    causation: txFacts.causationId as string | undefined,
    deltas,
  };
}

/** Attribution facts (actor, causationId) live ON the transaction entity via
 *  Tx-Meta headers, and aren't always surfaced in the tx's own delta — so read
 *  them back, exactly like history.ts does. Also resolves the causation hop. */
async function attributeTx(v: TxView): Promise<void> {
  if (v.actor && v.causation) return; // already present from the event
  try {
    const te = await readEntity(v.tx);
    v.actor = v.actor ?? (te.actor as string | undefined);
    v.causation = v.causation ?? (te.causationId as string | undefined);
  } catch {
    /* tx entity unreadable — leave unattributed */
  }
}

/** Give update-only deltas a human label (read the entity's current title) and
 *  fill in the transaction's actor/causation. */
async function enrich(v: TxView): Promise<void> {
  await Promise.all([
    attributeTx(v),
    ...v.deltas.map(async (d) => {
      if (d.label !== `#${d.entity}`) return;
      try {
        const e = await readEntity(d.entity);
        if (e.title) d.label = String(e.title);
        else if (e.kind) d.label = `${e.kind} #${d.entity}`;
      } catch {
        /* unreadable — keep #id */
      }
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Bus readers.
// ---------------------------------------------------------------------------

/** Replay past transactions (a burst, then idle) for a query; returns raw events. */
async function replayBus(qs: string, capMs = 3500): Promise<any[]> {
  const ac = new AbortController();
  const out: any[] = [];
  let idle: ReturnType<typeof setTimeout> | undefined;
  const cap = setTimeout(() => ac.abort(), capMs);
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(), 180); // 180ms quiet = replay burst done
  };
  try {
    // `Last-Event-ID: 1` replays from the first transaction, then goes live; we
    // stop on the first quiet gap, which is the end of the replay burst.
    await streamRecords(
      `/events/bus/stardust/transactions?${qs}`,
      (rec) => {
        out.push(rec);
        bump();
      },
      ac.signal,
      { "Last-Event-ID": "1" },
    );
  } catch {
    /* aborted (idle/cap) or dropped — return what we have */
  } finally {
    clearTimeout(idle);
    clearTimeout(cap);
  }
  return out;
}

/** Live feed: subscribe and patch the card list on every commit. Returns (never
 *  throws) when the stream drops so the caller can reconnect. */
export async function streamTxFeed(stream: any, signal: AbortSignal, buf: TxView[]): Promise<void> {
  await streamRecords(
    "/events/bus/stardust/transactions",
    async (ev) => {
      const v = decodeEvent(ev);
      if (!v) return;
      await enrich(v);
      buf.unshift(v);
      if (buf.length > 40) buf.length = 40;
      stream.patchElements(feedList(buf));
    },
    signal,
  );
}

/** Full provenance for one entity: per-field history + tx attribution. */
export async function provenance(id: EntityId) {
  const evs = await replayBus(`entityId=${id}`);
  const fields = new Map<string, { value: string; tx: number; at: string }[]>();
  for (const ev of evs) {
    const ba = ev.patched?.[String(id)];
    if (!ba) continue;
    const tx = ev.transaction?.["#"] ?? 0;
    const at = ev.committed ?? "";
    const after: Record<string, unknown> = ba.after ?? {};
    const before: Record<string, unknown> = ba.before ?? {};
    for (const [f, val] of Object.entries(after)) {
      if (f.startsWith("stardust/")) continue;
      const arr = fields.get(f) ?? [];
      arr.push({ value: fmtVal(val), tx, at });
      fields.set(f, arr);
    }
    for (const f of Object.keys(before)) {
      if (f.startsWith("stardust/") || f in after) continue;
      const arr = fields.get(f) ?? [];
      arr.push({ value: "∅ deleted", tx, at });
      fields.set(f, arr);
    }
  }
  // Attribution per transaction (read the tx entity's own facts).
  const txIds = new Set<number>();
  for (const arr of fields.values()) for (const e of arr) if (e.tx) txIds.add(e.tx);
  const attr = new Map<number, { actor?: string; via?: string }>();
  await Promise.all(
    [...txIds].map(async (t) => {
      try {
        const te = await readEntity(t);
        const actor = te.actor as string | undefined;
        const cause = String(te.causationId ?? "");
        let via: string | undefined;
        const m = cause.match(/^workflow:tx:(\d+)$/);
        if (m) {
          try {
            via = (await readEntity(Number(m[1]))).actor as string | undefined;
          } catch {
            /* trigger unreadable */
          }
        }
        attr.set(t, { actor: actor ?? (cause.startsWith("workflow") ? "workflow" : undefined), via });
      } catch {
        /* tx unreadable */
      }
    }),
  );
  return { id, fields, attr };
}

/** Replay the entire log and return the ordered app transactions (labels
 *  resolved from the create events in the same stream — no extra reads). */
export async function collectReplay(): Promise<TxView[]> {
  const evs = await replayBus("", 5000);
  const titles = new Map<number, string>();
  const out: TxView[] = [];
  for (const ev of evs) {
    for (const [eid, ba] of Object.entries<any>(ev.patched ?? {})) {
      const t = ba?.after?.title;
      if (t) titles.set(Number(eid), String(t));
    }
    const v = decodeEvent(ev);
    if (!v) continue;
    for (const d of v.deltas) if (d.label === `#${d.entity}` && titles.has(d.entity)) d.label = titles.get(d.entity)!;
    out.push(v);
  }
  // Attribute every transaction (bounded) so the replay shows who + why.
  await Promise.all(out.map((v) => attributeTx(v)));
  return out;
}

// ===========================================================================
// Rendering.
// ===========================================================================
const shortTime = (iso: string) => iso.replace("T", " ").replace(/\..*/, "").slice(5, 19); // MM-DD HH:MM:SS

function changeRow(c: FieldChange): string {
  const arrow =
    c.from === null
      ? `<span class="cv add">${esc(c.to ?? "")}</span>`
      : c.to === null
        ? `<span class="cv del">${esc(c.from)} → ∅</span>`
        : `<span class="cv"><span class="old">${esc(c.from)}</span> → <span class="new">${esc(c.to)}</span></span>`;
  return `<div class="chg"><span class="cf">${esc(c.field)}</span>${arrow}</div>`;
}

function entityBlock(d: EntityDelta): string {
  return `<div class="edelta">
    <button class="echip" data-on:click="@get('${B}/inspect/entity/${d.entity}')" title="inspect provenance">${esc(d.label)} <span class="eid">#${d.entity}</span></button>
    ${d.changes.map(changeRow).join("")}
  </div>`;
}

function txCard(v: TxView): string {
  const attr = v.actor ? `<span class="actor">${esc(v.actor)}</span>` : `<span class="actor anon">—</span>`;
  const cause = v.causation
    ? `<span class="cause ${v.causation.startsWith("workflow") ? "wf" : ""}">${esc(v.causation)}</span>`
    : "";
  return `<div class="txcard">
    <div class="txhead">
      <span class="txid">tx #${v.tx}</span>
      <span class="pills"><span class="pill a">+${v.asserted}</span><span class="pill r">-${v.retracted}</span><span class="pill u">~${v.unchanged}</span></span>
      ${attr}${cause}
      <span class="txtime">${esc(shortTime(v.at))}</span>
    </div>
    <div class="txbody">${v.deltas.map(entityBlock).join("")}</div>
  </div>`;
}

export function feedList(buf: TxView[]): string {
  const body = buf.length
    ? buf.map(txCard).join("")
    : `<div class="hint">Waiting for a commit… interact with the <a href="${B}/" target="_blank">todo app</a> and every write lands here — the real merge-patch, deltas, and who did it.</div>`;
  return `<div id="txfeed">${body}</div>`;
}

export function provenancePanel(p: Awaited<ReturnType<typeof provenance>>, id: EntityId): string {
  if (!p.fields.size) {
    return `<div id="prov"><div class="hint">No facts found for entity #${esc(String(id))}. Click an entity in the feed, or enter an id above.</div></div>`;
  }
  const attrOf = (tx: number) => {
    const a = p.attr.get(tx);
    if (!a?.actor) return "";
    return `<span class="pactor ${a.actor === "workflow" ? "wf" : ""}">${esc(a.actor)}${a.via ? ` · via ${esc(a.via)}` : ""}</span>`;
  };
  const rows = [...p.fields.entries()]
    .map(([field, entries]) => {
      const cur = entries[entries.length - 1];
      const hist = entries
        .map(
          (e) =>
            `<div class="ph"><span class="pv">${esc(e.value)}</span><span class="ptx">tx #${e.tx}</span>${attrOf(e.tx)}<span class="ptime">${esc(shortTime(e.at))}</span></div>`,
        )
        .join("");
      return `<div class="pfield">
        <div class="pfhead"><span class="pfname">${esc(field)}</span><span class="pfcur">${esc(cur.value)}</span></div>
        <div class="phist">${hist}</div>
      </div>`;
    })
    .join("");
  return `<div id="prov">
    <div class="provtitle">entity #${esc(String(id))} · ${p.fields.size} field(s) · fact history</div>
    ${rows}
  </div>`;
}

export function scrubber(list: TxView[]): string {
  if (!list.length) {
    return `<div id="replay"><div class="hint">No app transactions in the log yet.</div></div>`;
  }
  const last = list.length - 1;
  return `<div id="replay">
    <div class="rphead">${list.length} app transactions in the log · drag to replay history</div>
    <input class="rprange" type="range" min="0" max="${last}" value="${last}" data-bind:rp
           data-on:input__debounce.80ms="@get('${B}/inspect/replay/at')" />
    <div id="replayview">${replayView(list, last)}</div>
  </div>`;
}

export function replayView(list: TxView[], nRaw: number): string {
  const n = Math.max(0, Math.min(list.length - 1, nRaw | 0));
  let a = 0;
  let r = 0;
  for (let i = 0; i <= n; i++) {
    a += list[i].asserted;
    r += list[i].retracted;
  }
  const v = list[n];
  return `<div class="rvinner">
    <div class="rvmeta">transaction <b>${n + 1}</b> of ${list.length} · cumulative <span class="pill a">+${a}</span> <span class="pill r">-${r}</span> asserted/retracted through here</div>
    ${txCard(v)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Where the time went. The other three panels answer "what did the database do";
// this one answers "what did this server spend, and on how many rows" — which is
// the question every wrong number in this project's history was an answer to.
//
// Every read is drawn as `name ms · Nr`, and the row count is never omitted or
// abbreviated away, because the whole point is that 17ms over 0 rows and 17ms over
// 9,947 are not the same measurement. A read that was never issued (no row on the
// page is blocked, so no blocker query happens) is drawn `—` rather than `0r`, so
// "it matched nothing" and "it was not asked" stay distinguishable on the page as
// well as in the log.
// ---------------------------------------------------------------------------

const readChip = (r: RequestRecord["reads"][number]): string => {
  const rows = r.in === 0 && r.rows === 0 ? "—" : `${r.rows}r`;
  const asked = r.in !== undefined && r.in > 0 ? `<span class="tin">/${r.in}</span>` : "";
  return `<span class="tread"><span class="trn">${esc(r.read)}</span><span class="trms">${r.ms}</span><span class="trr">${rows}${asked}</span></span>`;
};

/** The filter, as one cell. Only what was NARROWED: an unfiltered board reads `—`,
 *  because a column that says "all, all, page 0" every row is a column nobody
 *  scans. The vocabulary size is only interesting next to a tag selection. */
const shapeText = (s: Record<string, unknown>): string =>
  Object.entries(s)
    .filter(([k]) => !(k === "vocab" && !s.tags))
    .filter(([, v]) => v !== 0 && !(Array.isArray(v) && !v.length) && v !== "all" && v !== "status")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : String(v)}`)
    .join(" ") || "—";

export function timingTable(recs: readonly RequestRecord[]): string {
  if (!recs.length) {
    return `<div id="timings"><div class="hint">No requests yet. Load the <a href="${B}/" target="_blank">board</a> — every rendered request lands here with its per-read breakdown, and the same record is on stdout (<code>journalctl … | grep '"t":"req"'</code>) and in the response itself with <code>?debug=1</code>.</div></div>`;
  }
  const rows = recs
    .map(
      (r) => `<tr>
      <td class="tseq">#${r.seq}</td>
      <td><span class="troute">${esc(r.route)}</span>${r.why ? `<span class="twhy">${esc(r.why)}</span>` : ""}</td>
      <td class="tshape">${esc(shapeText(r.shape))}</td>
      <td class="ttot">${r.ms}<span class="tms">ms</span></td>
      <td class="tren">${r.render}</td>
      <td class="treads">${r.reads.map(readChip).join("")}</td>
    </tr>`,
    )
    .join("");
  return `<div id="timings">
    <table class="ttab">
      <thead><tr><th></th><th>route</th><th>filter</th><th>total</th><th>render</th><th>reads · ms · rows</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------------------------
// Standalone page shell.
// ---------------------------------------------------------------------------
const DATASTAR = "https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js";

export function inspectPage(recs: readonly RequestRecord[]): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Glass Box · Stardust under the hood</title>
  <script type="module" src="${DATASTAR}"></script>
  <style>
    :root { color-scheme: dark; --bg:#0b0d10; --card:#14171c; --card2:#1a1e25; --fg:#e8e8ea; --mut:#8b93a1; --faint:#5b6472; --line:#242a33; --accent:#6c7bff; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; --add:#35b37e; --del:#f2555a; --wf:#c98bff; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--fg); font:13.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    .wrap { max-width:1180px; margin:24px auto; padding:0 20px; }
    h1 { font-size:19px; margin:0; display:flex; align-items:center; gap:10px; }
    .live { display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--mut); text-transform:uppercase; letter-spacing:.06em; }
    .dot { width:7px; height:7px; border-radius:50%; background:var(--add); box-shadow:0 0 0 0 var(--add); animation:pulse 1.8s infinite; }
    @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(53,179,126,.5);} 70%{box-shadow:0 0 0 7px rgba(53,179,126,0);} 100%{box-shadow:0 0 0 0 rgba(53,179,126,0);} }
    .sub { color:var(--mut); margin:4px 0 18px; font-size:12.5px; }
    .sub a, .hint a { color:var(--accent); }
    .cols { display:grid; grid-template-columns:1.35fr 1fr; gap:16px; align-items:start; }
    @media (max-width:900px){ .cols { grid-template-columns:1fr; } }
    .panel { border:1px solid var(--line); border-radius:12px; background:var(--card); overflow:hidden; }
    .phead { display:flex; align-items:center; gap:8px; padding:10px 13px; border-bottom:1px solid var(--line); font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--mut); }
    .phead .n { margin-left:auto; color:var(--faint); font-family:var(--mono); text-transform:none; letter-spacing:0; }
    .pbody { padding:11px 13px; max-height:62vh; overflow:auto; }
    .hint { color:var(--mut); font-size:12.5px; padding:16px 6px; line-height:1.6; }
    /* transaction card */
    .txcard { border:1px solid var(--line); border-radius:9px; background:var(--card2); margin-bottom:9px; }
    .txcard:last-child { margin-bottom:0; }
    .txhead { display:flex; align-items:center; gap:8px; padding:7px 10px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
    .txid { font-family:var(--mono); font-size:12px; color:var(--accent); }
    .pills { display:inline-flex; gap:3px; }
    .pill { font-family:var(--mono); font-size:10.5px; padding:0 5px; border-radius:5px; border:1px solid var(--line); }
    .pill.a { color:var(--add); } .pill.r { color:var(--del); } .pill.u { color:var(--faint); }
    .actor { font-size:11px; padding:1px 7px; border-radius:20px; background:var(--accent); color:#fff; }
    .actor.anon { background:transparent; color:var(--faint); border:1px solid var(--line); }
    .cause { font-family:var(--mono); font-size:10px; color:var(--mut); border:1px dashed var(--line); border-radius:5px; padding:0 5px; }
    .cause.wf { color:var(--wf); border-color:var(--wf); }
    .txtime { margin-left:auto; font-family:var(--mono); font-size:10.5px; color:var(--faint); }
    .txbody { padding:7px 10px; display:flex; flex-direction:column; gap:8px; }
    .edelta { border-left:2px solid var(--line); padding-left:9px; }
    .echip { display:inline-flex; align-items:center; gap:6px; border:0; background:transparent; color:var(--fg); font-size:12.5px; font-weight:600; cursor:pointer; padding:0 0 3px; }
    .echip:hover { color:var(--accent); }
    .eid { font-family:var(--mono); font-size:10.5px; color:var(--faint); font-weight:400; }
    .chg { display:flex; gap:8px; align-items:baseline; font-size:12px; padding:1px 0; }
    .cf { font-family:var(--mono); font-size:11px; color:var(--mut); min-width:78px; }
    .cv { font-family:var(--mono); font-size:11.5px; }
    .cv .old { color:var(--faint); text-decoration:line-through; } .cv .new { color:var(--fg); }
    .cv.add { color:var(--add); } .cv.del { color:var(--del); }
    /* provenance */
    .provbar { display:flex; gap:6px; padding:9px 13px; border-bottom:1px solid var(--line); }
    .provbar input { flex:1; background:var(--card2); border:1px solid var(--line); border-radius:7px; color:var(--fg); padding:5px 9px; font-size:12.5px; font-family:var(--mono); }
    .provbar button { border:1px solid var(--line); background:var(--card2); color:var(--fg); border-radius:7px; padding:0 12px; cursor:pointer; font-size:12.5px; }
    .provtitle { font-size:11.5px; color:var(--mut); margin-bottom:9px; font-family:var(--mono); }
    .pfield { border:1px solid var(--line); border-radius:8px; margin-bottom:7px; overflow:hidden; }
    .pfhead { display:flex; align-items:center; justify-content:space-between; padding:5px 9px; background:var(--card2); }
    .pfname { font-family:var(--mono); font-size:11.5px; color:var(--mut); }
    .pfcur { font-family:var(--mono); font-size:12px; color:var(--fg); }
    .phist { padding:4px 9px; }
    .ph { display:flex; align-items:center; gap:8px; padding:2px 0; font-size:11px; border-left:1.5px solid var(--line); padding-left:9px; margin-left:2px; }
    .pv { font-family:var(--mono); color:var(--fg); }
    .ptx { font-family:var(--mono); color:var(--faint); font-size:10px; }
    .pactor { font-size:10px; color:var(--accent); } .pactor.wf { color:var(--wf); }
    .ptime { margin-left:auto; font-family:var(--mono); font-size:10px; color:var(--faint); }
    /* timings */
    .ttab { width:100%; border-collapse:collapse; font-size:12px; }
    .ttab th { text-align:left; font-weight:500; color:var(--faint); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; padding:0 8px 6px 0; }
    .ttab td { padding:4px 8px 4px 0; border-top:1px solid var(--line); vertical-align:top; }
    .tseq { font-family:var(--mono); color:var(--faint); font-size:10.5px; }
    .troute { font-family:var(--mono); color:var(--accent); }
    .twhy { margin-left:6px; font-size:10px; color:var(--mut); border:1px dashed var(--line); border-radius:5px; padding:0 4px; }
    .tshape { font-family:var(--mono); color:var(--mut); font-size:11px; max-width:210px; }
    .ttot { font-family:var(--mono); color:var(--fg); text-align:right; white-space:nowrap; }
    .tms { color:var(--faint); font-size:10px; margin-left:1px; }
    .tren { font-family:var(--mono); color:var(--faint); text-align:right; }
    .treads { display:flex; flex-wrap:wrap; gap:4px; }
    .tread { display:inline-flex; align-items:baseline; gap:5px; border:1px solid var(--line); border-radius:6px; padding:0 6px; background:var(--card2); }
    .trn { font-family:var(--mono); font-size:10.5px; color:var(--mut); }
    .trms { font-family:var(--mono); font-size:11.5px; color:var(--fg); }
    .trr { font-family:var(--mono); font-size:10.5px; color:var(--add); }
    .tin { color:var(--faint); }
    /* replay */
    #replaywrap, #timingwrap { margin-top:16px; }
    .rphead { font-size:11.5px; color:var(--mut); margin-bottom:9px; }
    .rprange { width:100%; accent-color:var(--accent); margin-bottom:11px; }
    .rvmeta { font-size:11.5px; color:var(--mut); margin-bottom:8px; }
    .rvmeta b { color:var(--fg); }
  </style>
</head>
<body data-signals="{focusId:'', rp:0}">
  <div class="wrap">
    <h1>Glass Box <span class="live"><span class="dot"></span>live</span></h1>
    <p class="sub">What Stardust is actually doing under the <a href="${B}/" target="_blank">todo app</a> — decoded from the real commit bus, entity replay, and transaction facts. Nothing here is faked.</p>

    <div class="cols">
      <div class="panel">
        <div class="phead">Live transaction feed <span class="n">/events/bus/stardust/transactions</span></div>
        <div class="pbody" data-init="@get('${B}/inspect/stream', {retryInterval:300, retryMaxCount:100000})">
          <div id="txfeed"><div class="hint">Connecting to the commit bus…</div></div>
        </div>
      </div>

      <div class="panel">
        <div class="phead">Fact provenance <span class="n">entity replay · Last-Event-ID:1</span></div>
        <form class="provbar" data-on:submit__prevent="@get('${B}/inspect/entity')">
          <input type="text" name="focusId" data-bind:focus-id placeholder="entity id (or click one in the feed)" />
          <button>Inspect</button>
        </form>
        <div class="pbody">
          <div id="prov"><div class="hint">Click any entity in the transaction feed to see every field's history: the value, the transaction that set it, who did it, and when — read straight from temporal facts.</div></div>
        </div>
      </div>
    </div>

    <div class="panel" id="timingwrap">
      <div class="phead">Where the time went <span class="n">last ${recs.length} rendered request(s) · in memory, never a fact</span></div>
      <div class="pbody">
        <p class="sub" style="margin:0 0 10px">Server-side, per read, with the ROW COUNT beside every timing — because a read
        that matched nothing is fast, and from outside it looks exactly like a read that was quick.
        <code>—</code> means the query was never issued; <code>12r/50</code> means twelve rows came back for fifty asked about.
        The same records are one JSON line each on stdout, in any response with <code>?debug=1</code>, and at
        <a href="${B}/inspect/timings.json" target="_blank">/inspect/timings.json</a>.</p>
        <button class="provbar" style="border:1px solid var(--line);background:var(--card2);color:var(--fg);border-radius:7px;padding:6px 13px;cursor:pointer;display:inline-block;margin-bottom:10px" data-on:click="@get('${B}/inspect/timings')">Refresh ↻</button>
        ${timingTable(recs)}
      </div>
    </div>

    <div class="panel" id="replaywrap">
      <div class="phead">Replay the log <span class="n">Last-Event-ID:0 · event sourcing</span></div>
      <div class="pbody">
        <button class="provbar" style="border:1px solid var(--line);background:var(--card2);color:var(--fg);border-radius:7px;padding:6px 13px;cursor:pointer;display:inline-block" data-on:click="@get('${B}/inspect/replay')">Load &amp; replay history →</button>
        <div id="replay" style="margin-top:12px"><div class="hint">Replays every committed transaction from the beginning and lets you scrub through the board's real history.</div></div>
      </div>
    </div>
  </div>
</body>
</html>`;
}
