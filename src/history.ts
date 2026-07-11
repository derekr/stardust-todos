// Activity feed / status history for a todo — read straight from Stardust's
// temporal substrate. No audit table, no created_at/updated_at columns.
//
// Every fact carries its transaction. The transaction event bus, filtered to
// one entity + field and replayed from the start (Last-Event-ID: 1), hands back
// exactly that field's change history with commit timestamps, then goes live.

import { type EntityId, BASE } from "./stardust.ts";

export interface HistoryEntry {
  status: string;
  at: string; // ISO commit time
  tx: number;
}

/** The status timeline for one todo, oldest → newest. */
export async function statusHistory(id: EntityId): Promise<HistoryEntry[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 700); // replay arrives at once, then quiet
  const out: HistoryEntry[] = [];
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
          }
        } catch {
          /* keep-alive frame */
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  } finally {
    clearTimeout(timer);
  }
  return out;
}
