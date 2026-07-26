// The stress corpus, as pure functions of an index.
//
// Nothing about the generated todos is stored: every attribute of todo `k` is
// recomputed from `k`, so an oracle over a million rows costs a loop and no
// memory. That is the whole trick that makes million-row assertions affordable.
//
// The oracle below is written from the SPEC — what the board is supposed to mean —
// deliberately NOT by reading canonicalBody(). An oracle derived from the
// implementation cannot fail; it just restates the bug.

export const PRIORITY = ["low", "med", "high"] as const;
export const STATUS = ["todo", "doing", "blocked", "done"] as const;

type Priority = (typeof PRIORITY)[number];
type Status = (typeof STATUS)[number];

/** A todo as the generator defines it, before any derivation. */
export interface Row {
  k: number;
  status: Status;
  priority: Priority;
  done: boolean;
  draft: boolean;
  /** true when authored by the OWNER persona, false when by the member. */
  byOwner: boolean;
  lastActor: string;
  /** ms since epoch, or null when the todo has no due date at all. */
  due: number | null;
  tags: string[];
  /** index of the todo that blocks this one, or null. */
  blockedBy: number | null;
}

/** Deterministic corpus. Same `k` always means the same todo. */
export function row(k: number): Row {
  const status = STATUS[k % 4];
  const tags: string[] = [];
  if (k % 13 === 0) tags.push("alpha");
  if (k % 29 === 0) tags.push("beta");
  return {
    k,
    status,
    priority: PRIORITY[k % 3],
    done: status === "done",
    draft: k % 17 === 0,
    byOwner: k % 17 === 0 ? k % 34 === 0 : true, // half the drafts belong to the member
    lastActor: k % 5 === 0 ? "Owner" : "seed",
    due: k % 11 === 0 ? DUE_PAST : null,
    tags,
    // every 100th todo is blocked by its predecessor, whose status is known
    blockedBy: k % 100 === 7 && k > 0 ? k - 1 : null,
  };
}

/** A due date comfortably in the past for any plausible run date. */
const DUE_PAST = Date.UTC(2020, 0, 1);

/** Derived: an OPEN blocker exists. Exported because the corpus is now written
 *  WITH its consequences — the generator knows them, so `seed.ts` stores them. */
export function blocked(k: number): boolean {
  const b = row(k).blockedBy;
  return b !== null && row(b).status !== "done";
}

/** Priority as an ORDINAL (high 0, med 1, low 2) — the key an ordering should use.
 *  `PRIORITY.indexOf` is the reverse of it and stays that way, so the two cannot be
 *  confused: this is the spec for the stored `prank` field, that is the rank the
 *  ordering assertion reads. */
export const prank = (k: number): number => ({ high: 0, med: 1, low: 2 })[row(k).priority];

/** Derived: blocked overrides the stored status, but `done` beats blocked. */
export function effectiveStatus(k: number): string {
  const r = row(k);
  return blocked(k) && r.status !== "done" ? "blocked" : r.status;
}

/** Derived: past due and not finished. `now` is a PARAMETER — that is the point,
 *  and it is what the board's frozen `{#utc …}` literal was not. */
function overdue(k: number, now: number): boolean {
  const r = row(k);
  return r.due !== null && r.due < now && r.status !== "done";
}

export interface Facets {
  status: readonly string[];
  priority: readonly string[];
  tags: readonly string[];
  tagActive: boolean;
  view: "all" | "ready" | "overdue" | "done" | "mine";
  /** the persona the session is viewing as */
  viewerIsOwner: boolean;
  actor: string;
}

/**
 * Does todo `k` belong on the board for this session? The spec, in one place.
 *
 * Visibility first (a draft is yours or invisible), then the facet joins, then the
 * single-select view. Ordering is asserted separately.
 */
function onBoard(k: number, f: Facets, now: number): boolean {
  const r = row(k);
  const visible = !r.draft || r.byOwner === f.viewerIsOwner;
  if (!visible) return false;

  const eff = effectiveStatus(k);
  if (!f.priority.includes(r.priority)) return false;
  if (!f.status.includes(eff)) return false;
  if (f.tagActive && !r.tags.some((t) => f.tags.includes(t))) return false;

  switch (f.view) {
    case "all":
      return true;
    case "ready":
      return eff === "todo";
    case "done":
      return eff === "done";
    case "overdue":
      return overdue(k, now);
    case "mine":
      return r.lastActor === f.actor;
  }
}

/** Expected board membership across the whole corpus, as a count. */
export function expectedCount(n: number, f: Facets, now: number): number {
  let c = 0;
  for (let k = 0; k < n; k++) if (onBoard(k, f, now)) c++;
  return c;
}

/** Expected board membership as the explicit set of indexes (bounded slices). */
export function expectedSet(n: number, f: Facets, now: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (onBoard(k, f, now)) out.push(k);
  return out;
}
