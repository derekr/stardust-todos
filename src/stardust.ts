// Minimal, dependency-free Stardust client. Speaks only JSON over fetch + SSE.

export type EntityId = number;
export type Ref = { "#": EntityId | string };
export type MergePatch<T> = { [K in keyof T]?: T[K] | null };

export interface TxResult {
  transaction: Ref | number;
  tempIds?: Record<string, EntityId>;
  asserted: number;
  retracted: number;
  unchanged: number;
}

export interface ValidationDetail {
  instanceLocation: string;
  errors: Record<string, string>;
}
export interface ValidationError {
  valid: false;
  details: ValidationDetail[];
}
export type WriteResult<T> =
  | { ok: true; entityId: EntityId; result: TxResult }
  | { ok: false; status: number; error: ValidationError };

export const BASE = process.env.STARDUST_URL ?? "http://localhost:1981";

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; contentType?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = opts.contentType ?? "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

export interface TxMeta {
  /** Who performed the write — stored on the transaction as `actor`. */
  actor?: string;
  /** Links a derived write to the transaction that caused it (dataflow chains). */
  causationId?: string;
  correlationId?: string;
}

function metaHeaders(meta: TxMeta): Record<string, string> {
  const h: Record<string, string> = {};
  if (meta.actor) h["Tx-Meta-Actor"] = meta.actor;
  if (meta.causationId) h["Tx-Causation-Id"] = meta.causationId;
  if (meta.correlationId) h["Tx-Correlation-Id"] = meta.correlationId;
  return h;
}

export async function transact(
  map: Record<string, MergePatch<Record<string, unknown>>>,
  meta: TxMeta = {},
): Promise<TxResult> {
  return (await req("POST", "/commands/transact.json", { body: map, headers: metaHeaders(meta) })).json as TxResult;
}

/**
 * Subscribe to the committed-transaction event bus. Fires `onTx(id)` for each
 * transaction event (the id is the transaction id text). This is Stardust's
 * durable change feed — the trigger for event-driven dataflow.
 */
export async function subscribeTransactions(onTx: (txId: string) => void, signal: AbortSignal): Promise<void> {
  // One connection attempt. Returns (does not throw) when the stream drops —
  // Node's fetch has a ~5-min idle body timeout — so the caller can reconnect.
  // Only a real abort propagates.
  let res: Response;
  try {
    res = await fetch(`${BASE}/events/bus/stardust/transactions`, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
  } catch {
    return; // aborted or connection failed — caller inspects signal.aborted
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const idLine = frame.split("\n").find((l) => l.startsWith("id:"));
        if (idLine && frame.includes("event: stardust-transaction")) onTx(idLine.slice(3).trim());
      }
    }
  } catch {
    // abort, body timeout, or network drop — return; caller reconnects unless aborted
  }
}

export async function readEntity(id: EntityId): Promise<Record<string, unknown>> {
  return (await fetch(`${BASE}/entities/${id}.json`)).json();
}

export async function deleteEntity(id: EntityId): Promise<void> {
  await fetch(`${BASE}/entities/${id}`, { method: "DELETE" });
}

export async function createSchema(doc: unknown): Promise<{ schemaId: EntityId }> {
  return (await req("POST", "/schemas.json", { body: doc, contentType: "application/schema+json" })).json;
}

export async function readSchema(id: EntityId): Promise<{ status: number }> {
  const res = await fetch(`${BASE}/schemas/${id}`, { headers: { Accept: "application/schema+json" } });
  return { status: res.status };
}

/** Grow/patch a schema document in place (merge-patch semantics; no migration). */
export async function patchSchema(id: EntityId, mergePatch: unknown): Promise<void> {
  const { status } = await req("PATCH", `/schemas/${id}.json`, { body: mergePatch, contentType: "application/json" });
  if (status !== 200) throw new Error(`schema grow failed: ${status}`);
}

export async function createSchemaEntity<T>(
  schemaId: EntityId,
  body: MergePatch<T>,
  meta: TxMeta = {},
): Promise<WriteResult<T>> {
  const { status, json } = await req("POST", `/schemas/${schemaId}/entities.json`, {
    body,
    headers: metaHeaders(meta),
  });
  if (status === 200 || status === 201) return { ok: true, entityId: json.entityId, result: json.result };
  return { ok: false, status, error: json as ValidationError };
}

export async function patchSchemaEntity<T>(
  schemaId: EntityId,
  entityId: EntityId,
  patch: MergePatch<T>,
  meta: TxMeta = {},
): Promise<WriteResult<T>> {
  const { status, json } = await req("PATCH", `/schemas/${schemaId}/entities/${entityId}.json`, {
    body: patch,
    headers: metaHeaders(meta),
  });
  if (status === 200 || status === 201) return { ok: true, entityId: json.entityId, result: json.result };
  return { ok: false, status, error: json as ValidationError };
}

export async function createReactor(body: unknown): Promise<EntityId> {
  return (await req("POST", "/reactors.json", { body })).json.reactorId["#"];
}

/**
 * Run a one-shot datalog query (find/where/...) without storing a reactor.
 * `Row` types the result: `query<[EntityId, string]>(...)` for find-tuples, or
 * `query<Pick<Todo, "title" | "status">>(...)` for a `then.project` shape.
 */
export async function query<Row = unknown>(body: unknown): Promise<Row[]> {
  return (await req("POST", "/reactors/dry-run.json", { body })).json as Row[];
}

export async function readResults(id: EntityId): Promise<unknown[]> {
  return (await fetch(`${BASE}/reactors/${id}/results.json`)).json();
}

/** Stream a reactor's live JSON results. Calls onRows on every recompute. */
export async function streamResults(
  id: EntityId,
  onRows: (rows: unknown[]) => void,
  signal: AbortSignal,
): Promise<void> {
  // One connection attempt. Returns (does not throw) when the stream drops —
  // Node's fetch has a ~5-min idle body timeout — so the caller can reconnect.
  // Only a real abort propagates.
  let res: Response;
  try {
    res = await fetch(`${BASE}/reactors/${id}/results?format=json`, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
  } catch {
    return; // aborted or connection failed — caller inspects signal.aborted
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
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
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) {
          try {
            onRows(JSON.parse(data));
          } catch {
            /* keep-alive / non-JSON */
          }
        }
      }
    }
  } catch {
    // abort, body timeout, or network drop — return; caller reconnects unless aborted
  }
}
