// Bulk-load the stress corpus into a throwaway Stardust.
//
// Batching matters more than anything else here: 100 todos per transact ran at
// 7k facts/s and 5000 ran at 70k, a 10x difference for one constant. The response
// echoes a before/after patch for every entity, so a big batch also returns a
// megabyte we immediately throw away — that, not the write, is the ceiling.

import { blocked, effectiveStatus, prank, row } from "./model.ts";

const H = { Accept: "application/x-ndjson", "Content-Type": "application/json" };

export interface Seeded {
  base: string;
  workspace: number;
  owner: number;
  member: number;
  /** entity id of bulk todo k = firstTodo + k, ids being sequential per batch. */
  idOf: (k: number) => number;
  n: number;
}

export async function tx(base: string, patch: Record<string, unknown>): Promise<Record<string, number>> {
  const res = await fetch(`${base}/commands/transact`, { method: "POST", headers: H, body: JSON.stringify(patch) });
  const body = await res.text();
  if (!res.ok) throw new Error(`transact: ${res.status} ${body.slice(0, 300)}`);
  return JSON.parse(body).tempIds ?? {};
}

/**
 * Write `n` entities in batches, `make(k)` producing each — the batching, shared
 * with the demo's own bulk seed (`scripts/seed-scale.ts`).
 *
 * The batch size is the only constant here that matters: 100 entities per transact
 * ran at 7k facts/s and 5,000 ran at 70k, a 10x difference. The ceiling is not the
 * write — the response echoes a before/after patch for every entity, so a big batch
 * also returns a megabyte that is immediately thrown away.
 */
export async function bulk(
  base: string,
  n: number,
  make: (k: number) => Record<string, unknown>,
  batchSize: number,
  onBatch?: (done: number) => void,
): Promise<Int32Array> {
  const ids = new Int32Array(n);
  for (let off = 0; off < n; off += batchSize) {
    const size = Math.min(batchSize, n - off);
    const patch: Record<string, unknown> = {};
    for (let i = 0; i < size; i++) patch[`#_t${i}`] = make(off + i);
    const got = await tx(base, patch);
    for (let i = 0; i < size; i++) ids[off + i] = got[`t${i}`]!;
    onBatch?.(off + size);
  }
  return ids;
}

/**
 * Write `n` todos plus the workspace, personas, tags and dependency edges the
 * model describes. Returns a map from corpus index to entity id.
 *
 * Ids are captured per batch rather than assumed contiguous: entity ids are also
 * consumed by the facts themselves, so "first id + k" is not a safe shortcut.
 */
export async function seed(base: string, n: number, batchSize = 5000, log = console.log): Promise<Seeded> {
  const ids = await tx(base, {
    "#_ws": { kind: "workspace", name: "stress" },
    "#_owner": { kind: "persona", name: "Owner" },
    "#_member": { kind: "persona", name: "Member" },
  });
  const workspace = ids.ws!,
    owner = ids.owner!,
    member = ids.member!;
  log(`  workspace #${workspace}  owner #${owner}  member #${member}`);

  const t0 = Date.now();
  const idByK = await bulk(
    base,
    n,
    (k) => {
      const r = row(k);
      const t: Record<string, unknown> = {
        kind: "todo",
        app: "todo-app",
        workspace: { "#": workspace },
        title: `stress ${String(k).padStart(7, "0")}`,
        status: r.status,
        priority: r.priority,
        done: r.done,
        draft: r.draft,
        author: { "#": r.byOwner ? owner : member },
        lastActor: r.lastActor,
        // The derived fields, written WITH the row rather than backfilled after
        // it. The dep edges arrive later in this same seed, but the generator
        // already knows which ones it is going to write, so the consequence is
        // known before the cause — the same position the app's write paths are in.
        blocked: blocked(k),
        effectiveStatus: effectiveStatus(k),
        prank: prank(k),
      };
      // Same argument for the tag component: the board filters on `tags`, the tag
      // EDGES written below are the other half of the same fact, and the harness
      // asserts they agree (`reconcileTags`).
      if (r.tags.length) t.tags = [...r.tags].sort();
      if (r.due !== null) t.due = { "#utc": new Date(r.due).toISOString() };
      return t;
    },
    batchSize,
    (done) => {
      if (done % (batchSize * 20) === 0 || done >= n) {
        const secs = (Date.now() - t0) / 1000;
        log(`  todos ${done.toLocaleString()}/${n.toLocaleString()}  ${Math.round(done / secs).toLocaleString()}/s`);
      }
    },
  );

  // Edges second: they reference todos, so every id must already exist.
  const edges: Record<string, unknown> = {};
  let e = 0;
  for (let k = 0; k < n; k++) {
    const r = row(k);
    for (const label of r.tags) edges[`#_e${e++}`] = { kind: "tag", todo: { "#": idByK[k] }, label };
    if (r.blockedBy !== null) {
      edges[`#_e${e++}`] = { kind: "dep", todo: { "#": idByK[k] }, blocker: { "#": idByK[r.blockedBy] } };
    }
  }
  const keys = Object.keys(edges);
  for (let off = 0; off < keys.length; off += batchSize) {
    const slice: Record<string, unknown> = {};
    for (const key of keys.slice(off, off + batchSize)) slice[key] = edges[key];
    await tx(base, slice);
  }
  log(`  edges ${keys.length.toLocaleString()} (tags + deps)`);

  return { base, workspace, owner, member, idOf: (k) => idByK[k]!, n };
}

/** A session entity plus its facet rows, written the way the app writes them. */
export async function session(
  s: Seeded,
  sid: number,
  f: {
    status: readonly string[];
    priority: readonly string[];
    tags: readonly string[];
    tagActive: boolean;
    view: string;
    viewerIsOwner: boolean;
    actor: string;
  },
): Promise<number> {
  const ids = await tx(s.base, {
    "#_s": {
      kind: "session",
      sid,
      workspace: { "#": s.workspace },
      viewer: { "#": f.viewerIsOwner ? s.owner : s.member },
      view: f.view,
      actor: f.actor,
      tagActive: f.tagActive,
    },
  });
  const id = ids.s!;
  await setFacets(s, id, f);
  return id;
}

/** Replace a session's facets in ONE transaction, as writeFacets() does. */
async function setFacets(
  s: Seeded,
  sessionId: number,
  f: { status: readonly string[]; priority: readonly string[]; tags: readonly string[] },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  let i = 0;
  for (const [facet, values] of [
    ["status", f.status],
    ["priority", f.priority],
    ["tag", f.tags],
  ] as const) {
    for (const value of values) {
      patch[`#_f${i++}`] = { kind: "sf", session: { "#": sessionId }, facet, value };
    }
  }
  if (i) await tx(s.base, patch);
}
