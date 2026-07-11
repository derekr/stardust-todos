// Activity feed / status history for a todo — read straight from Stardust's
// temporal substrate. No audit table, no created_at/updated_at columns.
//
// Every fact carries its transaction. A one-shot facts read for this entity +
// field returns that field's full change history (newest-first, each row a value
// + its tx); we then read each transaction entity for its commit time and actor.
// History and attribution are free properties of the fact log — no event replay.

import { type EntityId, readEntity, readFacts, refId } from "./stardust.ts";

export interface HistoryEntry {
  status: string;
  at: string; // ISO commit time
  tx: number;
  actor?: string; // who committed the change (from Tx-Meta-Actor)
  via?: string; // for workflow changes: the actor of the triggering transaction
}

/**
 * The status timeline for one todo, oldest → newest.
 *
 * `GET /facts?entityId=<id>&field=status` returns every status assertion with its
 * transaction id and value, newest-first — the change history as one cheap read
 * (each `status` fact only exists because that write actually changed the value).
 * We reverse to chronological order, then enrich each entry from its transaction
 * entity: `stardust/committed` (commit instant) + `actor` (+ `causationId`).
 */
export async function statusHistory(id: EntityId): Promise<HistoryEntry[]> {
  const rows = await readFacts({ entityId: id, field: "status" });

  // Newest-first → chronological. One row per status assertion.
  const out: HistoryEntry[] = rows
    .filter((r) => typeof r.component === "string")
    .map((r) => ({ status: r.component as string, at: "", tx: refId(r.tx) }))
    .reverse();

  // Attribute + timestamp each change from its transaction entity. A workflow
  // write also carries `causationId` pointing at the transaction that triggered it.
  await Promise.all(
    out.map(async (e) => {
      if (!e.tx) return;
      try {
        const txe = await readEntity(e.tx);
        e.at = (txe["stardust/committed"] as { "#utc"?: string } | undefined)?.["#utc"] ?? "";
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
