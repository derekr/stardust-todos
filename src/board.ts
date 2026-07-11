// Linear-style filtering, grouping, and aggregates — powered by Stardust
// queries. Every filter is an AND-composed positive predicate (Stardust's `or`
// and compound `not` are unreliable — verified — so multi-value/negation is
// composed in this thin layer instead). Counts use groupBy aggregates.

import type { WorkspaceCtx } from "./workspace.ts";
import type { Priority, Status, Todo } from "./todos.ts";
import { type EntityId, query } from "./stardust.ts";
import { query as tquery } from "./typed-query.ts"; // compile-time-checked query for static literals
import { APP } from "./tenancy.ts";
import { overdue, ready } from "./features.ts";

export type DerivedView = "all" | "ready" | "overdue" | "mine";
export type GroupBy = "none" | "status" | "priority";

export interface Filter {
  status: Status[]; // empty = all (multi-select via `contains {#set ...}`)
  priority: Priority[];
  tags: string[];
  view: DerivedView;
  group: GroupBy;
}

export const emptyFilter: Filter = { status: [], priority: [], tags: [], view: "all", group: "status" };

const asId = (v: unknown): EntityId => (typeof v === "number" ? v : (v as { "#": EntityId })["#"]);
// Fixed "now" for deterministic overdue demos on the seeded data.
const NOW_ISO = "2026-07-11T00:00:00Z";

/** Todos matching the filter (AND-composed), projected app-shaped by Stardust. */
export async function filteredTodos(ctx: WorkspaceCtx, f: Filter, mineActor?: string): Promise<Todo[]> {
  const where: unknown[] = [
    ["?t", "app", APP],
    ["?t", "workspace", { "#": ctx.workspaceId }],
    ["?t", "title", "?title"],
    ["?t", "status", "?status"],
    ["?t", "priority", "?priority"],
    ["?t", "done", "?done"],
    ["?t", "lastActor", "?lastActor"],
  ];
  // Multi-select membership: `contains {#set [...]} ?field` (an expression
  // predicate — the correct Stardust idiom for "value in a set").
  if (f.status.length) where.push(["contains", { "#set": f.status }, "?status"]);
  if (f.priority.length) where.push(["contains", { "#set": f.priority }, "?priority"]);
  if (f.view === "mine" && mineActor) where.push(["?t", "lastActor", mineActor]); // "changed by me"
  if (f.tags.length) {
    where.push(["?e", "kind", "tag"], ["?e", "todo", "?t"], ["?e", "label", "?l"], ["contains", { "#set": f.tags }, "?l"]);
  }

  const rows = (await query({
    find: ["?t", "?title", "?done", "?priority", "?status", "?lastActor"],
    where,
    orderBy: ["?priority", "?title"],
    then: {
      project: {
        id: "?t",
        title: "?title",
        done: "?done",
        priority: "?priority",
        status: "?status",
        lastActor: "?lastActor",
      },
    },
  })) as Todo[];

  // A tag join can duplicate a todo (one row per matching tag) — dedupe by id.
  const seen = new Map<EntityId, Todo>();
  for (const t of rows) seen.set(t.id, t);
  let todos = [...seen.values()];

  if (f.view === "ready") {
    const ids = new Set((await ready(ctx)).map((r) => r.id));
    todos = todos.filter((t) => ids.has(t.id));
  } else if (f.view === "overdue") {
    const ids = new Set((await overdue(ctx, NOW_ISO)).map((r) => r.id));
    todos = todos.filter((t) => ids.has(t.id));
  }
  return todos;
}

/** Count of todos per status in the workspace (groupBy aggregate).
 *  Written with the compile-time-checked `tquery`: field names (app / workspace
 *  / status) are validated against the generated schema map — a typo is a build
 *  error. (Dynamic filter-building, e.g. filteredTodos, stays on the raw query.) */
export async function statusCounts(ctx: WorkspaceCtx): Promise<Record<string, number>> {
  const rows = await tquery({
    find: ["?status", ["count", "?t"]],
    where: [["?t", "app", APP], ["?t", "workspace", { "#": ctx.workspaceId }], ["?t", "status", "?status"]],
    groupBy: ["?status"],
  } as const); // rows: ["todo"|"doing"|"blocked"|"done", number][] — inferred, no cast
  return Object.fromEntries(rows);
}

/** Count of todos per priority in the workspace. */
export async function priorityCounts(ctx: WorkspaceCtx): Promise<Record<string, number>> {
  const rows = await tquery({
    find: ["?priority", ["count", "?t"]],
    where: [["?t", "app", APP], ["?t", "workspace", { "#": ctx.workspaceId }], ["?t", "priority", "?priority"]],
    groupBy: ["?priority"],
  } as const); // rows: ["low"|"med"|"high", number][] — inferred, no cast
  return Object.fromEntries(rows);
}

export interface Blocker {
  id: EntityId;
  title: string;
  status: Status;
}

/** Map of todo id -> its blockers (all dep edges in the workspace, one query). */
export async function blockerMap(ctx: WorkspaceCtx): Promise<Map<EntityId, Blocker[]>> {
  const rows = (await query({
    find: ["?t", "?b", "?bt", "?bs"],
    where: [
      ["?d", "kind", "dep"],
      ["?d", "todo", "?t"],
      ["?t", "workspace", { "#": ctx.workspaceId }],
      ["?d", "blocker", "?b"],
      ["?b", "title", "?bt"],
      ["?b", "status", "?bs"],
    ],
  })) as [unknown, unknown, string, Status][];
  const map = new Map<EntityId, Blocker[]>();
  for (const [t, b, bt, bs] of rows) {
    const id = asId(t);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push({ id: asId(b), title: bt, status: bs });
  }
  return map;
}

/** Distinct tag labels used in the workspace. */
export async function availableTags(ctx: WorkspaceCtx): Promise<string[]> {
  const rows = (await query({
    find: ["?label"],
    where: [
      ["?e", "kind", "tag"],
      ["?e", "todo", "?t"],
      ["?t", "workspace", { "#": ctx.workspaceId }],
      ["?e", "label", "?label"],
    ],
    orderBy: ["?label"],
  })) as [string][];
  return [...new Set(rows.map((r) => r[0]))];
}

/** All todos in the workspace as {id,title} — for the "add blocker" picker. */
export async function todoOptions(ctx: WorkspaceCtx): Promise<{ id: EntityId; title: string }[]> {
  const rows = (await query({
    find: ["?t", "?title"],
    where: [["?t", "app", APP], ["?t", "workspace", { "#": ctx.workspaceId }], ["?t", "title", "?title"]],
    orderBy: ["?title"],
  })) as [EntityId, string][];
  return rows.map(([id, title]) => ({ id: asId(id), title }));
}
