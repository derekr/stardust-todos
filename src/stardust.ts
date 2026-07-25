// Minimal, dependency-free Stardust 0.0.6 client.
//
// 0.0.6 unified every machine route on ONE shape: a *record stream* in a
// negotiated profile. The `.json` route aliases, the `?format=json` switches and
// the `text/event-stream` machine feeds this app used to speak are all gone.
// We negotiate NDJSON — `application/x-ndjson`, one compact JSON value per
// LF-terminated line — because it is the cheapest profile to parse from JS, and
// finite reads and live subscriptions then share a single line reader.
//
// Three consequences show up all over the rest of the app:
//   * ids come back as refs (`{"#": 12}`), so everything goes through `refId()`
//   * a live route is made finite with `?max=1` rather than "read the first frame
//     and hang up" — reaching `max` is clean completion, not an error
//   * failures arrive as a terminal `{"stardust/error": true, code, message}`
//     record, which this module surfaces as `StardustError` (or, for writes, as
//     the `ok: false` arm of `WriteResult`)

export type EntityId = number;
/** @public — part of this module's surface; no in-repo consumer yet. */
export type Ref = { "#": EntityId | string };

/**
 * Normalize a value to an entity id. 0.0.6 returns ids in ref position as
 * `{"#": id}` — including `schemaId`, `entityId`, `reactorId`, and the `tx` on a
 * fact row — while a subject-position query var still comes back bare.
 * One helper, imported everywhere, instead of a per-file `asId` copy.
 */
export const refId = (v: unknown): EntityId => (typeof v === "number" ? v : Number((v as { "#": EntityId })["#"]));
export type MergePatch<T> = { [K in keyof T]?: T[K] | null };

export const BASE = process.env.STARDUST_URL ?? "http://localhost:1981";

/** The record profile we negotiate on every machine route. */
const NDJSON = "application/x-ndjson";

export interface TxResult {
  transaction: Ref | number;
  tempIds?: Record<string, EntityId>;
  asserted: number;
  retracted: number;
  unchanged: number;
}

// ---- Record streams ---------------------------------------------------------

/** The terminal item of a failed record stream. @public */
export interface ErrorRecord {
  "stardust/error": true;
  code: string;
  message: string;
  details?: unknown;
}

const isErrorRecord = (r: unknown): r is ErrorRecord =>
  !!r && typeof r === "object" && (r as Record<string, unknown>)["stardust/error"] === true;

/** A record stream that ended in `stardust/error`. @public */
export class StardustError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  constructor(rec: ErrorRecord, status: number) {
    super(rec.message);
    this.name = "StardustError";
    this.code = rec.code;
    this.status = status;
    this.details = rec.details;
  }
}

/** Split an NDJSON body into records. Profile guarantees one compact value per line. */
function parseRecords(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* truncated tail — the caller sees the records that did arrive */
    }
  }
  return out;
}

interface ReqOpts {
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

/** One finite machine call: send a document, read the whole record stream back. */
async function req(
  method: string,
  path: string,
  opts: ReqOpts = {},
): Promise<{ status: number; records: any[]; error?: ErrorRecord }> {
  const headers: Record<string, string> = { Accept: NDJSON, ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = opts.contentType ?? "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + path, { method, headers, body });
  const records = parseRecords(await res.text());
  const last = records[records.length - 1];
  return { status: res.status, records, error: isErrorRecord(last) ? last : undefined };
}

/** The single record a finite route is documented to return; throws on error. */
async function one<T>(method: string, path: string, opts: ReqOpts = {}): Promise<T> {
  const { status, records, error } = await req(method, path, opts);
  if (error) throw new StardustError(error, status);
  return records[0] as T;
}

/**
 * Read a live record stream, calling `onRecord` per item. Returning `false` from
 * `onRecord` closes the stream. An async handler is awaited before the next
 * record is read, so a slow consumer applies backpressure instead of interleaving.
 *
 * One connection attempt: returns (does not throw) when the stream drops — Node's
 * fetch has a ~5-min idle body timeout — so the caller can reconnect. Only a real
 * abort propagates via `signal`.
 */
export async function streamRecords(
  path: string,
  onRecord: (rec: any) => boolean | void | Promise<boolean | void>,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { headers: { Accept: NDJSON, ...headers }, signal });
  } catch {
    return; // aborted or connection failed — caller inspects signal.aborted
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // partial or non-JSON line
        }
        if (isErrorRecord(rec)) return; // terminal item — the stream is over
        if ((await onRecord(rec)) === false) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
  } catch {
    // abort, body timeout, or network drop — return; caller reconnects unless aborted
  }
}

// ---- Writes -----------------------------------------------------------------

/** @public — part of this module's surface; no in-repo consumer yet. */
export interface ValidationDetail {
  instanceLocation: string;
  errors: Record<string, string>;
}
/** A rejected write, flattened from the terminal `stardust/error` record. @public */
export interface ValidationError {
  valid: false;
  code: string;
  message: string;
  details: ValidationDetail[];
}
export type WriteResult =
  | { ok: true; entityId: EntityId; result: TxResult }
  | { ok: false; status: number; error: ValidationError };

/** 0.0.6 nests the per-location failures one level under the error item's `details`. */
function toValidationError(rec: ErrorRecord): ValidationError {
  const d = rec.details as { details?: ValidationDetail[] } | undefined;
  return { valid: false, code: rec.code, message: rec.message, details: d?.details ?? [] };
}

/**
 * A write guarded by `Tx-Check-Last` was rejected (409) because the entity
 * changed since the caller last saw it — optimistic-concurrency conflict.
 * `info` is Stardust's error record: code `transaction_conflict`, with
 * `details.expectedTx` / `details.actualTx` naming both versions.
 */
export class TxConflictError extends Error {
  readonly entity: EntityId;
  readonly info: unknown;
  constructor(entity: EntityId, info: unknown) {
    super(`transaction precondition failed for entity ${entity}`);
    this.name = "TxConflictError";
    this.entity = entity;
    this.info = info;
  }
}

/** `Tx-Check-Last` map (entity id → the tx it must have last changed in). */
export type CheckLast = Record<EntityId, number>;

function checkLastHeaders(checkLast?: CheckLast): Record<string, string> {
  if (!checkLast || !Object.keys(checkLast).length) return {};
  return { "Tx-Check-Last-Type": "json", "Tx-Check-Last": JSON.stringify(checkLast) };
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
  return one<TxResult>("POST", "/commands/transact", { body: map, headers: metaHeaders(meta) });
}

/** One current fact row. `tx` and `entity` are refs; `component` is the value. */
export interface FactRow {
  entity: Ref | number;
  field: number | string;
  tx: Ref | number;
  component: unknown;
}

/**
 * Current fact rows, newest-first. `GET /facts` returns ONE record holding the
 * whole collection — not a record per fact.
 */
export async function readFacts(params: Record<string, string | number>): Promise<FactRow[]> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  return (await one<FactRow[]>("GET", `/facts?${qs}`)) ?? [];
}

/**
 * The transaction that last touched `id` (its entity-level "version"), read from
 * the fact log newest-first. Feed this back as `Tx-Check-Last` to make a later
 * write conditional on "the entity is still exactly as I saw it". 0 = no facts.
 */
export async function lastTx(id: EntityId): Promise<number> {
  const rows = await readFacts({ entityId: id, limit: 1 });
  return rows[0] ? refId(rows[0].tx) : 0;
}

// ---- Entities ---------------------------------------------------------------

/** `GET /entities/{id}` is a live route in 0.0.6; `max=1` takes just the current snapshot. */
export async function readEntity(id: EntityId): Promise<Record<string, unknown>> {
  return (await one<Record<string, unknown>>("GET", `/entities/${id}?max=1`)) ?? {};
}

/**
 * Watch one entity. The same route without `max` is the live form: the current
 * snapshot first, then a fresh one whenever the entity's own facts change. This is
 * Stardust noticing the change instead of the app subscribing to every commit and
 * filtering — but note the scope is exactly this entity, so a change to something
 * that merely REFERENCES it (a new tag edge) does not appear here.
 */
export async function watchEntity(
  id: EntityId,
  onSnapshot: (e: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<void> {
  await streamRecords(`/entities/${id}`, (rec) => void onSnapshot(rec as Record<string, unknown>), signal);
}

export async function deleteEntity(id: EntityId): Promise<void> {
  await fetch(`${BASE}/entities/${id}`, { method: "DELETE", headers: { Accept: NDJSON } });
}

// ---- Schemas ----------------------------------------------------------------

export async function createSchema(doc: unknown): Promise<{ schemaId: EntityId }> {
  const rec = await one<{ schemaId: Ref | number }>("POST", "/schemas", {
    body: doc,
    contentType: "application/schema+json",
  });
  return { schemaId: refId(rec.schemaId) };
}

/**
 * Does this schema exist? 200 = yes.
 *
 * `application/schema+json` is the media type for SENDING a schema document, not
 * for reading one back: 0.0.6 answers a read with `406 Not Acceptable` unless you
 * negotiate a record profile. That 406 used to read as "missing" here, so every
 * boot created ANOTHER Todo schema — five of them accumulated in the demo.
 * A missing id answers 400, not 404.
 */
export async function readSchema(id: EntityId): Promise<{ status: number }> {
  const res = await fetch(`${BASE}/schemas/${id}`, { headers: { Accept: NDJSON } });
  return { status: res.status };
}

/** Grow/patch a schema document in place (merge-patch semantics; no migration). */
export async function patchSchema(id: EntityId, mergePatch: unknown): Promise<void> {
  const { status, error } = await req("PATCH", `/schemas/${id}`, {
    body: mergePatch,
    contentType: "application/merge-patch+json",
  });
  if (error) throw new StardustError(error, status);
}

export async function createSchemaEntity<T>(
  schemaId: EntityId,
  body: MergePatch<T>,
  meta: TxMeta = {},
): Promise<WriteResult> {
  const { status, records, error } = await req("POST", `/schemas/${schemaId}/entities`, {
    body,
    headers: metaHeaders(meta),
  });
  if (error) return { ok: false, status, error: toValidationError(error) };
  const rec = records[0] as { entityId: Ref | number; result: TxResult };
  return { ok: true, entityId: refId(rec.entityId), result: rec.result };
}

export async function patchSchemaEntity<T>(
  schemaId: EntityId,
  entityId: EntityId,
  patch: MergePatch<T>,
  meta: TxMeta = {},
  opts: { checkLast?: CheckLast } = {},
): Promise<WriteResult> {
  const { status, records, error } = await req("PATCH", `/schemas/${schemaId}/entities/${entityId}`, {
    body: patch,
    contentType: "application/merge-patch+json",
    headers: { ...metaHeaders(meta), ...checkLastHeaders(opts.checkLast) },
  });
  if (error) return { ok: false, status, error: toValidationError(error) };
  const rec = records[0] as { entityId?: Ref | number; result?: TxResult } & TxResult;
  return {
    ok: true,
    entityId: rec.entityId !== undefined ? refId(rec.entityId) : entityId,
    result: rec.result ?? rec,
  };
}

// ---- Reactors ---------------------------------------------------------------

export async function createReactor(body: unknown): Promise<EntityId> {
  const rec = await one<{ reactorId: Ref | number }>("POST", "/reactors", { body });
  return refId(rec.reactorId);
}

/** A stored reactor document. The query body lives under `reactor`. */
export interface ReactorDoc {
  reactorId: Ref | number;
  enabled?: boolean;
  reactor: Record<string, unknown>;
}

export async function readReactor(id: EntityId): Promise<ReactorDoc> {
  return one<ReactorDoc>("GET", `/reactors/${id}`);
}

/** Replace a stored reactor's body. Note: plain JSON — reactors reject merge-patch. */
export async function patchReactor(id: EntityId, body: unknown): Promise<ReactorDoc> {
  return one<ReactorDoc>("PATCH", `/reactors/${id}`, { body, contentType: "application/json" });
}

/**
 * Run a one-shot datalog query (find/where/...) without storing a reactor.
 * `Row` types the result: `query<[EntityId, string]>(...)` for find-tuples, or
 * `query<Pick<Todo, "title" | "status">>(...)` for a `then.project` shape.
 *
 * The dry run is finite and returns ONE record holding the whole row collection.
 */
export async function query<Row = unknown>(body: unknown): Promise<Row[]> {
  return (await one<Row[]>("POST", "/reactors/dry-run", { body })) ?? [];
}

/** Values a reactor var can be bound to at read time. A `Ref` binds an entity —
 *  which is how a query scoped by `[?t workspace ?ws]` is parameterized per read. */
export type Bind = Record<string, string | number | Ref>;

/** Render a bind override as a RON object for the `?bind=` results param:
 *  `{ sid: 42 }` → `{sid 42}`, `{ v: "x" }` → `{v 'x'}`, `{ ws: {"#":12} }` →
 *  `{ws {# 12}}`. Per-subscription bind lets ONE stored reactor serve many
 *  parameterizations, so a scoped query needs one reactor, not one per scope. */
function ronBind(bind: Bind): string {
  const lit = (v: string | number | Ref): string => {
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return `'${v}'`;
    return `{# ${refId(v)}}`;
  };
  return `{${Object.entries(bind)
    .map(([k, v]) => `${k} ${lit(v)}`)
    .join(" ")}}`;
}

function bindQuery(bind?: Bind): string {
  return bind ? `&bind=${encodeURIComponent(ronBind(bind))}` : "";
}

/** The reactor's current result. Stored results are a live route, so `max=1`
 *  takes the current nested result and completes. */
export async function readResults(id: EntityId, bind?: Bind): Promise<unknown[]> {
  return (await one<unknown[]>("GET", `/reactors/${id}/results?max=1${bindQuery(bind)}`)) ?? [];
}

/** Stream a reactor's live results. Calls onRows on every recompute — each record
 *  is the complete new result, not a delta.
 *  `bind` overrides the reactor's bind values for THIS stream (per-subscription). */
export async function streamResults(
  id: EntityId,
  onRows: (rows: unknown[]) => void,
  signal: AbortSignal,
  bind?: Bind,
): Promise<void> {
  const q = bindQuery(bind).replace(/^&/, "?");
  await streamRecords(`/reactors/${id}/results${q}`, (rows) => void onRows(rows as unknown[]), signal);
}
