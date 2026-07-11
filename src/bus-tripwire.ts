// Board/detail change-tripwires driven by the TRANSACTION EVENT BUS instead of
// the per-workspace reactor result stream — drop-in alternatives to todos.ts
// `watchTodos` for the WEB streams (whose callbacks ignore the streamed rows and
// just re-render via a fresh dry-run).
//
// WHY: a reactor result stream only re-emits when an entity bound in its
// top-level `where` changes — VERIFIED against Stardust 0.0.4. The workspace
// board reactor's `where` is over todo fields only, so it is BLIND to tag and
// dependency EDGE writes (separate entities), and enriching its `then.project`
// with `$exists` does NOT help (projection subqueries don't drive invalidation,
// also verified). So other tabs miss "tag added" / "became blocked" until some
// todo field happens to change.
//
// The bus sees EVERY commit, so it never misses. Its one weakness is scope: the
// bus filters only by entityId/field, never by workspace/kind — so we do a cheap
// app-side relevance check (does this commit touch what THIS view renders?) and
// re-render only then. This trades the reactor's free server-side scoping for
// completeness — the property the reactor tripwire was failing.

import { type EntityId, query, readEntity, refId, streamRecords } from "./stardust.ts";
import type { WorkspaceCtx } from "./workspace.ts";
import { APP } from "./tenancy.ts";

type Ref = { "#": EntityId } | undefined;
const ref = (v: unknown): EntityId | undefined => (v as Ref)?.["#"];

/** True if an unknown affected entity is an edge (tag/dep) pointing at a member. */
async function edgeHitsMember(id: EntityId, members: Set<EntityId>): Promise<boolean> {
  const e = await readEntity(id).catch(() => ({}) as Record<string, unknown>);
  const t = ref(e.todo);
  const b = ref(e.blocker);
  return (t !== undefined && members.has(t)) || (b !== undefined && members.has(b));
}

/**
 * Shared bus loop: rebuild the relevant-id set, then fire `onChange` once per
 * committed transaction whose affected entities are relevant. Fast path checks
 * affected ids against the member set; slow path reads only UNKNOWN affected ids
 * (creates) — one read per unseen entity, never per member.
 *
 * One connection attempt; returns (does not throw) when the stream drops so the
 * caller can reconnect — matching stardust.ts stream helpers. Only a real abort
 * propagates via `signal`.
 */
async function watchBus(
  buildMembers: () => Promise<Set<EntityId>>,
  classifyUnknown: (id: EntityId, members: Set<EntityId>) => Promise<boolean>,
  onChange: () => void,
  signal: AbortSignal,
): Promise<void> {
  let members = await buildMembers();

  // The bus record IS the bare transaction result — `patched` keys are the
  // entities this commit touched.
  await streamRecords(
    "/events/bus/stardust/transactions",
    async (ev: { patched?: Record<string, unknown> }) => {
      const affected = Object.keys(ev.patched ?? {}).map(Number);
      if (!affected.length) return;

      let relevant = affected.some((id) => members.has(id));
      if (!relevant) {
        for (const id of affected) {
          if (await classifyUnknown(id, members)) {
            relevant = true;
            break;
          }
        }
      }
      if (relevant) {
        members = await buildMembers(); // refresh so new/removed rows are tracked next tick
        onChange();
      }
    },
    signal,
  );
}

// ---- Board: everything in the workspace the board renders --------------------

/** This workspace's todos + the tag/dep edges that reference them. */
async function boardMembers(ctx: WorkspaceCtx): Promise<Set<EntityId>> {
  const ws = { "#": ctx.workspaceId };
  const todos = (await query({
    find: ["?t"],
    where: [
      ["?t", "app", APP],
      ["?t", "workspace", ws],
    ],
  })) as [EntityId][];
  const ids = new Set<EntityId>(todos.map((r) => r[0]));
  const byTodo = (await query({
    find: ["?e"],
    where: [
      ["?e", "todo", "?t"],
      ["?t", "workspace", ws],
    ],
  })) as [EntityId][];
  const byBlk = (await query({
    find: ["?e"],
    where: [
      ["?e", "blocker", "?t"],
      ["?t", "workspace", ws],
    ],
  })) as [EntityId][];
  for (const [e] of byTodo) ids.add(e);
  for (const [e] of byBlk) ids.add(e);
  return ids;
}

/**
 * Fire `onChange` once per committed transaction that affects this workspace's
 * board. Same shape of use as `watchTodos(ctx, () => renderBoard(...), signal)`,
 * but catches the tag/dependency edge writes the reactor stream misses.
 */
export function watchBoardChanges(ctx: WorkspaceCtx, onChange: () => void, signal: AbortSignal): Promise<void> {
  return watchBus(
    () => boardMembers(ctx),
    async (id, members) => {
      // a new/updated todo in this workspace, or a new edge on one of our todos
      const e = await readEntity(id).catch(() => ({}) as Record<string, unknown>);
      if (e.app === APP && ref(e.workspace) === ctx.workspaceId) return true;
      const t = ref(e.todo);
      const b = ref(e.blocker);
      return (t !== undefined && members.has(t)) || (b !== undefined && members.has(b));
    },
    onChange,
    signal,
  );
}

// ---- Detail: one todo + exactly what its detail card renders -----------------

/** The detail of `todoId` renders its own fields, its tags, and its dependency
 *  neighbors' titles/statuses — so the relevant set is the todo, its tag/dep
 *  edges, AND the one-hop neighbor todos (a blocker completing must repaint). */
async function detailMembers(todoId: EntityId): Promise<Set<EntityId>> {
  const t = { "#": todoId };
  const ids = new Set<EntityId>([todoId]);
  const out = (await query({
    find: ["?e", "?b"],
    where: [
      ["?e", "kind", "dep"],
      ["?e", "todo", t],
      ["?e", "blocker", "?b"],
    ],
  })) as [EntityId, unknown][]; // todoId depends on ?b
  const inc = (await query({
    find: ["?e", "?d"],
    where: [
      ["?e", "kind", "dep"],
      ["?e", "blocker", t],
      ["?e", "todo", "?d"],
    ],
  })) as [EntityId, unknown][]; // ?d depends on todoId
  const tags = (await query({
    find: ["?e"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", t],
    ],
  })) as [EntityId][];
  for (const [e, b] of out) {
    ids.add(e);
    ids.add(refId(b));
  }
  for (const [e, d] of inc) {
    ids.add(e);
    ids.add(refId(d));
  }
  for (const [e] of tags) ids.add(e);
  return ids;
}

/**
 * Fire `onChange` per committed transaction affecting `todoId`'s detail card —
 * its own fields, its tags/dependencies, or a dependency neighbor's status. The
 * bus is filtered app-side to that neighborhood (a focused version of the board
 * tripwire), so it's precise without missing the edge-derived parts a raw
 * `?entityId` server-side filter would drop.
 */
export function watchEntityChanges(todoId: EntityId, onChange: () => void, signal: AbortSignal): Promise<void> {
  return watchBus(() => detailMembers(todoId), edgeHitsMember, onChange, signal);
}
