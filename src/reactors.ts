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
// the Laravel port does with one reactor. It does not generalize: Stardust
// allocates entity ids from the high-water mark, so claiming id 900001 on a fresh
// database drags the allocator up with it. Measured: the next ordinary entity was
// assigned 900008, and 900002 was already consumed. A second named reactor at a
// neighbouring id could never be created. Names have no such arithmetic.

import { type EntityId, createReactor, patchReactor, query, readReactor, refId, transact } from "./stardust.ts";
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
