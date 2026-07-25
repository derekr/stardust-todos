// Named reactors, provisioned once and then reused.
//
// A reactor is stored state: creating one is a write, and a reactor created per
// process start accumulates forever. The board reactor used to do exactly that —
// `ensureBoardReactor()` memoized in a module variable, so every restart minted
// another live reactor.
//
// Reactors are therefore looked up by NAME, not by id. A tiny `reactorRef` entity
// records (app, name) -> reactor, and provisioning is: find the ref, create the
// reactor and its ref if absent, otherwise reconcile the stored body against the
// definition here and PATCH only when they differ.
//
// Why not a fixed id? `POST /reactors/{id}` is atomic and idempotent (409
// entity_exists), which makes "provision at a configured id" tempting — it is what
// the Laravel port does with its single reactor. It does not generalize, and not
// for the reason you would guess: creating a reactor at 900001 CONSUMES A BLOCK of
// ids (the clauses are entities too), so 900002 is already taken with zero writes
// in between. The block size tracks the query — measured, a 1-clause reactor took
// 6 ids and a 5-clause reactor with orderBy + project took 27 — so there is no
// stride a caller could reserve. Names have no such arithmetic.
//
// What this gives up versus fixed ids: the 409 made creation atomic, whereas two
// setups racing here can both miss the marker and create two reactors. Provisioning
// is a deploy step, not a hot path, so that trade is deliberate.

import {
  type Bind,
  type EntityId,
  createReactor,
  patchReactor,
  query,
  readReactor,
  readResults,
  refId,
  streamResults,
  transact,
} from "./stardust.ts";
import { type QueryLiteral, type ResultOf, rowValidator } from "./typed-query.ts";
import { APP } from "./tenancy.ts";

export interface Provisioned {
  name: string;
  id: EntityId;
  /** "created" first time, "updated" when the stored body had drifted, else "current". */
  status: "created" | "updated" | "current";
}

/** Order-insensitive structural comparison, so key order never reads as drift. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

/** The reactor previously provisioned under this name, if any. */
async function lookup(name: string): Promise<EntityId | undefined> {
  const rows = (await query({
    find: ["?r", "?rid"],
    where: [
      ["?r", "kind", "reactorRef"],
      ["?r", "app", APP],
      ["?r", "name", name],
      ["?r", "reactor", "?rid"],
    ],
  })) as [unknown, unknown][];
  return rows.length ? refId(rows[0][1]) : undefined;
}

/**
 * Make the reactor named `name` exist and match `body`. Safe to call on every
 * boot: it writes only when something actually differs.
 *
 * `enabled` is stored beside the query rather than inside it, so it is compared
 * separately from the body Stardust echoes back under `reactor`.
 */
export async function ensureReactor(name: string, body: Record<string, unknown>): Promise<Provisioned> {
  const existing = await lookup(name);
  if (existing === undefined) {
    const id = await createReactor(body);
    await transact({ "#_ref": { kind: "reactorRef", app: APP, name, reactor: { "#": id } } });
    return { name, id, status: "created" };
  }

  const { enabled: wantEnabled = true, ...wantQuery } = body;
  const stored = await readReactor(existing);
  if (stable(stored.reactor) === stable(wantQuery) && (stored.enabled ?? true) === wantEnabled) {
    return { name, id: existing, status: "current" };
  }
  await patchReactor(existing, body);
  return { name, id: existing, status: "updated" };
}

// ---------------------------------------------------------------------------
// Declared reactors: one definition, a typed reader and a typed subscription.
// ---------------------------------------------------------------------------

/**
 * A named, stored query. `define()` gives you what sqlc gives you — declare the
 * query once, get typed accessors — except the row type is INFERRED from the
 * literal by `ResultOf` rather than emitted into a generated file, so there is no
 * artifact to drift out of sync.
 *
 * Rows are validated at the boundary by the same schema-generated validators
 * `typed-query.query()` uses. It does NOT apply that module's compile-time
 * `CheckQuery`: the checker models plain 3-tuple fact clauses, and these queries
 * deliberately use `or` and a bound `exists`, which it cannot express.
 *
 * Parameters are per-read BINDS, so one stored reactor serves every caller: a var
 * left unbound by `where` is supplied at read time (`?bind={ws {# 12}}`), and
 * leaving it out matches everything — which is why every read here passes one.
 */
export interface Declared<Q extends QueryLiteral> {
  readonly name: string;
  /** The reactor's current result for these binds. */
  read(bind: Bind): Promise<ResultOf<Q>[]>;
  /** The current result, then a fresh one on every recompute, until `signal` aborts. */
  watch(bind: Bind, onRows: (rows: ResultOf<Q>[]) => void, signal: AbortSignal): Promise<void>;
  /** The provisioned reactor id (ensures it on first use). */
  id(): Promise<EntityId>;
  /** Create or reconcile this reactor now, reporting what changed. */
  provision(): Promise<Provisioned>;
}

export function define<const Q extends QueryLiteral>(name: string, body: Q): Declared<Q> {
  const provision = () => ensureReactor(name, body as unknown as Record<string, unknown>);
  let pending: Promise<EntityId> | null = null;
  const id = () => (pending ??= provision().then((r) => r.id));

  const q = body as unknown as QueryLiteral;
  const validate = q.then?.project ? rowValidator(q.where, q.then.project) : null;
  const checked = (rows: unknown[]): ResultOf<Q>[] => {
    if (validate) {
      rows.forEach((row, i) => {
        const err = validate(row);
        if (err) throw new Error(`reactor '${name}' row ${i}: ${err}`);
      });
    }
    return rows as ResultOf<Q>[];
  };

  return {
    name,
    id,
    provision,
    async read(bind) {
      return checked(await readResults(await id(), bind));
    },
    async watch(bind, onRows, signal) {
      await streamResults(await id(), (rows) => onRows(checked(rows)), signal, bind);
    },
  };
}
