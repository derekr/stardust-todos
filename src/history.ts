// Activity feed / status history for a todo — read straight from Stardust's
// temporal substrate. No audit table, no created_at/updated_at columns.
//
// Every fact carries its transaction. The transaction event bus, filtered to
// one entity + field and replayed from the start (Last-Event-ID: 1), hands back
// exactly that field's change history with commit timestamps, then goes live.

import { type EntityId, BASE, readEntity } from "./stardust.ts";

export interface HistoryEntry {
  status: string;
  at: string; // ISO commit time
  tx: number;
  actor?: string; // who committed the change (from Tx-Meta-Actor / causation)
  via?: string; // for workflow changes: the actor of the triggering transaction
}

/**
 * The status timeline for one todo, oldest → newest.
 *
 * The replay arrives as a burst, then the stream goes quiet (live mode). We
 * can't be told when the replay ends, so we stop at the first IDLE GAP after
 * the first event (with a hard cap), instead of always waiting a fixed window.
 */
export async function statusHistory(id: EntityId): Promise<HistoryEntry[]> {
  const ac = new AbortController();
  const out: HistoryEntry[] = [];
  let idle: ReturnType<typeof setTimeout> | undefined;
  const cap = setTimeout(() => ac.abort(), 900); // fallback if events never arrive
  const bumpIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(), 120); // 120ms quiet after the last event = replay done
  };
  try {
    const res = await fetch(
      `${BASE}/events/bus/stardust/transactions?entityId=${id}&field=status&format=json`,
      { headers: { Accept: "text/event-stream", "Last-Event-ID": "1" }, signal: ac.signal },
    );
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        try {
          const ev = JSON.parse(data);
          const after = ev.patched?.[String(id)]?.after;
          if (after && typeof after.status === "string") {
            out.push({ status: after.status, at: ev.committed, tx: ev.transaction?.["#"] ?? 0 });
            bumpIdle();
          }
        } catch {
          /* keep-alive frame */
        }
      }
    }
  } catch {
    // abort (idle/cap) or drop — return what we collected
  } finally {
    clearTimeout(idle);
    clearTimeout(cap);
  }
  // Attribute each change: read its transaction's stored actor (or causation).
  await Promise.all(
    out.map(async (e) => {
      if (!e.tx) return;
      try {
        const txe = await readEntity(e.tx);
        const actor = txe.actor as string | undefined;
        const cause = String(txe.causationId ?? "");
        e.actor = actor ?? (cause.startsWith("workflow") ? "workflow" : undefined);
        // Causation hop: a workflow write carries workflow:tx:<N> — read that
        // triggering transaction's actor so we can show *why* it fired.
        const m = cause.match(/^workflow:tx:(\d+)$/);
        if (m) {
          try {
            const trigger = await readEntity(Number(m[1]));
            e.via = trigger.actor as string | undefined;
          } catch {
            /* trigger unreadable */
          }
        }
      } catch {
        /* tx entity unreadable — leave unattributed */
      }
    }),
  );
  return out;
}
