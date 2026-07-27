// The board's filter, as a query string.
//
// It used to be FACTS: a `session` entity plus one `sf` child per selected value,
// rewritten in one transaction on every click, and a `/s/<sid>` URL naming the
// session. That was the app's headline claim — "the server holds no filter state"
// — and it is reversed here, on measurement and on two behaviours nobody had
// looked at closely. AGENTS.md carries the full entry; the short version is three
// findings, each verified against the running demo before anything was deleted.
//
// **The facts bought no reactivity.** The one thing a fact buys that a parameter
// cannot is a subscriber waking up. `session-page` — the app's only board
// subscription since the page-set landed — has no `sf` clause and no `page`
// clause, so a filter write re-emitted NOTHING. The repaint came from `remount()`
// in server.ts, which aborted the SSE stream and re-opened it. The app had been
// re-opening the stream by hand for a while; what a URL removes is the machinery
// that worked around a subscription that was never going to fire.
//
// **They cost writes that never stop costing.** ~129 facts per session and ~46 per
// filter click, on an append-only store where a retraction is more facts. The demo
// held twelve todos in 24,389 facts across 7,274 entities and 84 sessions. And the
// churn taxes UNRELATED writes permanently: a three-fact todo patch measured 4ms at
// 7.5k facts, 9ms at 192k and 17ms at 369k, reproduced by growing the database with
// entities the patch never touches. A filter click is the cheapest interaction on
// the page and it was making every future write slower.
//
// **A mutable session is the wrong thing to share.** `/s/<sid>` handed a second
// reader the SAME session, so two people on one link shared one filter and
// overwrote each other's clicks. A URL-encoded filter gives each recipient an
// independent view of the same board — which is what sharing a filtered board has
// always meant everywhere else.
//
// The property the facts were supposed to protect survives intact. "The server
// holds no per-user filter state" is exactly as true of a query string, and it was
// never true of the server generally — `liveSessions`, `boardStreams`, `boardGate`
// and `viewPersona` were all per-process state sitting beside it.
//
// What a URL costs, said plainly: the filter is now INPUT, arriving from a client
// rather than from a schema-checked write. So `inDomain` stops being a belt to the
// braces of a schema and becomes the only check there is — which is why every
// decode below runs it, why an unknown value is a refusal rather than a shrug, and
// why `tags` (free text, no fixed domain) is checked against the workspace's actual
// tag vocabulary instead. The app never string-builds RON; a value lands in an
// array cell of a JSON body. The domain check is what makes an unrecognised value
// LOUD rather than a query that quietly matches nothing — or, worse, a dropped
// clause that quietly matches everything.

import type { Priority, Status } from "./todos.ts";

/** The fixed domains. Every value that reaches a query body as a literal is
 *  checked against one of these; `tags` has no fixed domain and is checked against
 *  the workspace's vocabulary instead (see `decodeFilter`). */
export const STATUS_DOMAIN = ["todo", "doing", "blocked", "done"] as const;
export const PRIORITY_DOMAIN = ["low", "med", "high"] as const;
export const VIEW_DOMAIN = ["all", "ready", "overdue", "mine", "done"] as const;
const GROUP_DOMAIN = ["none", "status", "priority"] as const;

type DerivedView = (typeof VIEW_DOMAIN)[number];
type GroupBy = (typeof GROUP_DOMAIN)[number];

export interface Filter {
  status: Status[]; // empty = all
  priority: Priority[];
  tags: string[];
  view: DerivedView;
  group: GroupBy; // display-only: how the rendered rows are grouped
}

/** The whole of what a board URL says: what to match, and which page of it. */
export interface BoardState {
  filter: Filter;
  page: number;
}

export const emptyFilter: Filter = { status: [], priority: [], tags: [], view: "all", group: "status" };
export const emptyState: BoardState = { filter: emptyFilter, page: 0 };

/**
 * A value that arrived in a URL and is not one this app knows.
 *
 * Its own class so the server can answer 400 for it and 500 for everything else —
 * a hand-edited query string is a client error, and telling the two apart is the
 * difference between a log full of noise and a log worth reading.
 */
export class FilterError extends Error {}

const KEY = { status: "st", priority: "pr", tags: "tag", view: "v", group: "g", page: "p" } as const;

/** One multi-select, checked value by value. An unknown value is REFUSED: this is
 *  the boundary where data becomes query, and the only safe answers are "a value I
 *  recognise" and "no". Dropping it instead would WIDEN the board, which is the
 *  failure mode that is invisible. */
function pick<T extends string>(raw: string | null, domain: readonly T[], what: string): T[] {
  if (!raw) return [];
  const out: T[] = [];
  for (const v of raw.split(",")) {
    if (!v) continue;
    if (!(domain as readonly string[]).includes(v)) {
      throw new FilterError(`${what} '${v}' is not one of ${domain.join(", ")}`);
    }
    if (!out.includes(v as T)) out.push(v as T);
  }
  return out;
}

/** A single-select, same rule. */
function one<T extends string>(raw: string | null, domain: readonly T[], what: string, fallback: T): T {
  if (!raw) return fallback;
  if (!(domain as readonly string[]).includes(raw)) {
    throw new FilterError(`${what} '${raw}' is not one of ${domain.join(", ")}`);
  }
  return raw as T;
}

/**
 * The board state a URL describes.
 *
 * `vocabulary` is the workspace's tag labels — `availableTags()`, which the render
 * reads anyway to draw the tag chips. It is passed in rather than fetched here so
 * that this stays a pure function (the unit tests are the whole point of that) and
 * so that one read serves both the check and the chips.
 *
 * A tag that is not in the vocabulary is refused like any other unknown. That is
 * strict on purpose, and it has one visible consequence worth naming: a shared link
 * whose tag has since been removed from every todo answers 400 rather than quietly
 * dropping the chip and showing a wider board. A wider board is the failure you do
 * not notice.
 */
export function decodeFilter(params: URLSearchParams, vocabulary: readonly string[]): BoardState {
  const rawPage = params.get(KEY.page);
  const page = rawPage === null ? 0 : Number(rawPage);
  if (!Number.isSafeInteger(page) || page < 0) throw new FilterError(`page '${rawPage}' is not a page number`);
  return {
    filter: {
      status: pick(params.get(KEY.status), STATUS_DOMAIN, "status"),
      priority: pick(params.get(KEY.priority), PRIORITY_DOMAIN, "priority"),
      tags: pick(params.get(KEY.tags), vocabulary, "tag"),
      view: one(params.get(KEY.view), VIEW_DOMAIN, "view", "all"),
      group: one(params.get(KEY.group), GROUP_DOMAIN, "group", "status"),
    },
    page,
  };
}

/**
 * The query string for a board state — `""` when nothing is narrowed, so the
 * unfiltered board is a bare `/`.
 *
 * Every value written here came out of a domain, so this and `decodeFilter` are
 * inverses on anything the app itself produces. The tests hold that down; a codec
 * that round-trips everything except the one case a link is shared in would be
 * worse than no codec.
 */
export function encodeFilter(s: BoardState): string {
  const p = new URLSearchParams();
  const { filter: f } = s;
  if (f.status.length) p.set(KEY.status, f.status.join(","));
  if (f.priority.length) p.set(KEY.priority, f.priority.join(","));
  if (f.tags.length) p.set(KEY.tags, f.tags.join(","));
  if (f.view !== "all") p.set(KEY.view, f.view);
  if (f.group !== "status") p.set(KEY.group, f.group);
  if (s.page > 0) p.set(KEY.page, String(s.page));
  const q = p.toString();
  return q ? `?${q}` : "";
}

/** The href a board state is reachable at. */
export const boardHref = (s: BoardState): string => `/${encodeFilter(s)}`;

const flip = <T>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

/**
 * The state a chip click leads to — the read-modify-write that used to happen on
 * the server against the session's facts, done here against the URL instead.
 *
 * Any change to WHAT matches returns to page 1. Keeping the offset would leave a
 * reader on page 7 of a result that now has two, staring at an empty board that is
 * not empty. `group` is display-only and so keeps the page.
 */
export function toggled(s: BoardState, facet: string, value: string): BoardState {
  const f = s.filter;
  switch (facet) {
    case "status":
      return { filter: { ...f, status: flip(f.status, value as Status) }, page: 0 };
    case "priority":
      return { filter: { ...f, priority: flip(f.priority, value as Priority) }, page: 0 };
    case "tag":
      return { filter: { ...f, tags: flip(f.tags, value) }, page: 0 };
    case "view":
      return { filter: { ...f, view: f.view === value ? "all" : (value as DerivedView) }, page: 0 };
    case "group":
      return { filter: { ...f, group: value as GroupBy }, page: s.page };
    default:
      throw new FilterError(`unknown facet '${facet}'`);
  }
}
