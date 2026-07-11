// Durable workflows, the Stardust way.
//
// Theory (docs/theory/reactors): "reactors define and observe; writes still
// cross the write boundary." So a durable workflow is NOT a hidden trigger. It
// is: derivation rules expressed as queries (the durable intent) + an applier
// that crosses the write boundary when facts change (the execution), linked by
// a causation id so the dataflow chain is auditable.
//
// Rules here derive todo status from the dependency graph, and project status
// from its todos:
//   A  todo  + has an incomplete blocker            -> blocked
//   B  blocked + no incomplete blocker              -> todo
//   C  active project, all todos done (>=1)         -> done
//   D  done project, has an open todo               -> active
//
// Each rule is a POSITIVE query (+ set-diff where negation is needed), because
// Stardust's not/or-not don't compose safely. The applier is idempotent: it
// only writes real transitions, so it reaches a fixpoint and stops.

import { type EntityId, query, transact } from "./stardust.ts";
import { APP } from "./tenancy.ts";

const asId = (v: unknown): EntityId => (typeof v === "number" ? v : (v as { "#": EntityId })["#"]);
const ids = (rows: unknown[]): EntityId[] => [...new Set((rows as unknown[][]).map((r) => asId(r[0])))];

// A: todos (status "todo") with an incomplete blocker -> should be "blocked".
async function toBlock(): Promise<EntityId[]> {
  return ids(
    await query({
      find: ["?t"],
      where: [
        ["?t", "app", APP],
        ["?t", "status", "todo"],
        ["?d", "kind", "dep"],
        ["?d", "todo", "?t"],
        ["?d", "blocker", "?b"],
        ["?b", "status", "?bs"],
        ["!=", "?bs", "done"],
      ],
    }),
  );
}

// B: todos (status "blocked") with NO incomplete blocker -> should be "todo".
async function toUnblock(): Promise<EntityId[]> {
  const blocked = ids(await query({ find: ["?t"], where: [["?t", "app", APP], ["?t", "status", "blocked"]] }));
  const stillBlocked = new Set(
    ids(
      await query({
        find: ["?t"],
        where: [
          ["?t", "app", APP],
          ["?t", "status", "blocked"],
          ["?d", "kind", "dep"],
          ["?d", "todo", "?t"],
          ["?d", "blocker", "?b"],
          ["?b", "status", "?bs"],
          ["!=", "?bs", "done"],
        ],
      }),
    ),
  );
  return blocked.filter((id) => !stillBlocked.has(id));
}

// C: active projects whose todos are all done (and it has at least one).
async function toClose(): Promise<EntityId[]> {
  const withTodos = ids(
    await query({
      find: ["?p"],
      where: [["?p", "kind", "project"], ["?p", "status", "active"], ["?t", "project", "?p"], ["?t", "app", APP]],
    }),
  );
  const withOpen = new Set(
    ids(
      await query({
        find: ["?p"],
        where: [
          ["?p", "kind", "project"],
          ["?p", "status", "active"],
          ["?t", "project", "?p"],
          ["?t", "status", "?s"],
          ["!=", "?s", "done"],
        ],
      }),
    ),
  );
  return withTodos.filter((id) => !withOpen.has(id));
}

// D: done projects that have an open todo again -> reopen.
async function toReopen(): Promise<EntityId[]> {
  return ids(
    await query({
      find: ["?p"],
      where: [
        ["?p", "kind", "project"],
        ["?p", "status", "done"],
        ["?t", "project", "?p"],
        ["?t", "status", "?s"],
        ["!=", "?s", "done"],
      ],
    }),
  );
}

export interface WorkflowRun {
  applied: number;
  blocked: EntityId[];
  unblocked: EntityId[];
  closed: EntityId[];
  reopened: EntityId[];
}

/** One derivation pass: compute all transitions and apply them in one write. */
export async function runWorkflows(causationId?: string): Promise<WorkflowRun> {
  const [blocked, unblocked, closed, reopened] = await Promise.all([toBlock(), toUnblock(), toClose(), toReopen()]);
  const patch: Record<string, Record<string, unknown>> = {};
  for (const id of blocked) patch[id] = { status: "blocked", done: false };
  for (const id of unblocked) patch[id] = { status: "todo", done: false };
  for (const id of closed) patch[id] = { status: "done" };
  for (const id of reopened) patch[id] = { status: "active" };
  const applied = Object.keys(patch).length;
  if (applied) await transact(patch, { causationId });
  return { applied, blocked, unblocked, closed, reopened };
}

/** Run passes until nothing changes (cascades converge; idempotent). */
export async function runToFixpoint(causationId?: string, maxPasses = 12): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxPasses; i++) {
    const { applied } = await runWorkflows(causationId);
    total += applied;
    if (!applied) break;
  }
  return total;
}

/**
 * The durable worker: react to every committed transaction by running the
 * derivation to a fixpoint, tagging its writes with the causing transaction id.
 * Serialized so overlapping events don't race; its own writes converge to empty
 * and stop (no infinite loop).
 */
export async function startWorker(
  signal: AbortSignal,
  onRun?: (txId: string, applied: number) => void,
): Promise<void> {
  const { subscribeTransactions } = await import("./stardust.ts");
  let running = false;
  let pending = false;
  const pump = async (txId: string) => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    do {
      pending = false;
      const applied = await runToFixpoint(`workflow:tx:${txId}`);
      onRun?.(txId, applied);
    } while (pending);
    running = false;
  };
  await subscribeTransactions((txId) => void pump(txId), signal);
}
