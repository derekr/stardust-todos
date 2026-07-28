// The chips' tally — held in memory, and pushed by the engine when it moves.
//
// The count chips are deliberately NOT narrowed by the active facets: that is what
// makes them mean "how many you would get if you picked this". So a page turn
// cannot change them, and neither can a filter change — only a write to the
// workspace's todos can. Yet the tally was READ on every render. Moving it off the
// critical path (started before the rows, patched in when it lands) hid the cost
// from a reader; it did not stop paying it, and at 10,003 todos it was 240ms of
// engine work per paint for an answer that was almost always the previous one.
//
// So the app stops asking. One subscription per (workspace, viewer) in use keeps
// the latest emission in memory, every render reads that, and Stardust pushes a new
// one when the underlying data moves. Same shape as `page-rows` in pageset.ts — the
// reactor pushes its own result and nothing watches for changes — applied to the
// one read on this page that could never be narrowed.
//
// It buys something on top of the time, which was not the point and is the better
// half. A paint used to be the only thing that could move these numbers, so a write
// to a todo that is not on the page you are reading left them stale until something
// else happened. The emission patches them itself now, with no read behind it, so
// the chips are live for the first time.
//
// THE BIND TRADE REVERSES HERE, and that is the whole reason `board-counts` is a
// stored reactor again. Per READ a bind is a real cost: the same body is 197ms
// through the stored reactor with `?ws`/`?viewer` and 132ms as a dry-run with both
// spelled as literals, because a value the planner has when it plans is one it can
// narrow on. That measurement is unchanged and it is why this was inlined in the
// first place. It is also per-read, and a subscription pays it ONCE: the 65ms
// buys a body that can be subscribed at all, and every push after it is free.
// Measured on the demo, first subscribe vs every render after it: see AGENTS.md.
//
// The alternative that would keep the literals is a reactor per (workspace,
// viewer) with both inlined — and it is refused for the reason ephemeral reactors
// were refused for deep pages: creating one costs 31-44ms and a BLOCK of entity
// ids that deleting it does not give back. That is a permanent write for a
// one-time 65ms, on the app that removed the session entity for exactly this.
//
// VIEWER-SCOPED, so the key is (workspace, viewer) and not workspace alone. A
// draft you cannot see must not be counted, and the subscription enforces that at
// the source rather than in a filter afterwards: verified on a throwaway with two
// subscriptions on ONE reactor, one bound to each persona, while a third process
// wrote. A draft authored by the other persona moved the author's tally and did
// not wake the other subscription AT ALL. See AGENTS.md for the full sequence.
//
// WHAT IS HELD, AND WHY IT DOES NOT LEAK. This app has a history of per-session
// state that outlived the thing it was about (84 session entities for twelve
// todos), so the lifetime is spelled out rather than assumed:
//
//   * A subscription is REFCOUNTED by the open board streams looking at that
//     scope. A stream takes one hold when it opens and gives it back when it
//     closes, and re-keys it on a repaint — so a "view as" or workspace switch
//     moves every open board onto the new scope and the old one falls to zero.
//   * At zero it LINGERS briefly rather than closing at once, because a filter
//     change is a NAVIGATION: the browser closes the old stream and opens a new
//     one on the same scope, and without the grace period every filter click
//     would re-pay the subscribe it was supposed to remove.
//   * The linger timer is `unref`d, so a lingering subscription cannot hold the
//     process open, and the entry is deleted from the map when it fires. With no
//     board open, this module holds nothing at all.
//   * Nothing here WRITES. A tally is a question, and the answer being kept in
//     memory is a fact about this process, not about the world — the same call
//     the page-set free list makes one file over.

import type { EntityId } from "./stardust.ts";
import { boardCounts } from "./queries.ts";

/** The two tallies the chips and the sidebar draw. */
export interface Counts {
  status: Record<string, number>;
  priority: Record<string, number>;
}

/**
 * The engine's (effectiveStatus, priority) groups, folded into the two tallies the
 * chips want.
 *
 * The fold stays app-side and the grouping does not: eleven rows come back out of
 * 9,947 todos. Making it two `groupBy` reactors instead is possible and
 * deliberately not done — the chips want every value present including its zero,
 * and adding up eleven numbers twice is not what this page costs.
 */
function tally(rows: readonly (readonly [string, string, number])[]): Counts {
  const status: Record<string, number> = {};
  const priority: Record<string, number> = {};
  for (const [eff, pri, n] of rows) {
    status[eff] = (status[eff] ?? 0) + n;
    priority[pri] = (priority[pri] ?? 0) + n;
  }
  return { status, priority };
}

/** How many todos a tally covered. */
const counted = (c: Counts): number => Object.values(c.status).reduce((n, x) => n + x, 0);

/** How long a subscription with no board behind it waits before closing. A filter
 *  change is a new document and a new stream, and the old one closes first, so
 *  the gap this covers is a browser navigation rather than a reader going away. */
const LINGER_MS = 30_000;

/** How long to wait before re-subscribing after the upstream stream DROPS —
 *  Node's fetch gives up on a response body after ~5 idle minutes. The same 500ms
 *  the board's own stream loop backs off by. */
const REOPEN_MS = 500;

/** How many re-subscribes to try before giving up on a scope that has never
 *  emitted. A stream that ends on an error record RETURNS rather than throwing, so
 *  a body the engine refuses would otherwise reconnect forever in silence. Giving
 *  up deletes the entry, so the next board to open tries again. */
const OPEN_TRIES = 3;

/** One live subscription: the latest emission, and who is looking at it. */
interface Sub {
  readonly key: string;
  /** open board streams holding this scope */
  refs: number;
  /** the latest emission, or null until the first one lands */
  now: Counts | null;
  /** what to tell each holder when a new one arrives — one entry per open stream,
   *  so the chips are patched by the EMISSION rather than by the next page view */
  readonly holders: Set<(c: Counts) => void>;
  readonly ac: AbortController;
  /** set while nobody holds this scope; firing closes the subscription */
  idle: NodeJS.Timeout | null;
}

const subs = new Map<string, Sub>();

const keyOf = (ws: EntityId, viewer: EntityId): string => `${ws}:${viewer}`;

/** The scopes with a live subscription and how many streams hold each — reported
 *  by `/page.json` beside the idle page-sets, because "what is this process still
 *  holding" is a question this app has had to answer the hard way before. */
export const liveCountScopes = (): Record<string, number> => Object.fromEntries([...subs].map(([k, s]) => [k, s.refs]));

function open(ws: EntityId, viewer: EntityId): Sub {
  const key = keyOf(ws, viewer);
  const sub: Sub = { key, refs: 1, now: null, holders: new Set(), ac: new AbortController(), idle: null };
  subs.set(key, sub);

  void (async () => {
    let tries = 0;
    while (!sub.ac.signal.aborted) {
      // One line per SUBSCRIBE and one per PUSH, each with a row count beside its
      // duration — the same rule the request log follows (timing.ts), and the only
      // place this read is visible now that no render makes it. `ms` on an `open` is
      // the whole price of the bind, paid once for the scope; on a `push` it is the
      // gap since the previous emission. `rows` is what the tally covered, because a
      // tally over nothing is instant and would look excellent.
      let last = performance.now();
      await boardCounts.watch(
        { ws: { "#": ws }, viewer: { "#": viewer } },
        (rows) => {
          const why = sub.now === null ? "open" : "push";
          sub.now = tally(rows as unknown as [string, string, number][]);
          const at = performance.now();
          const line = {
            t: "counts",
            why,
            scope: key,
            ms: Math.round((at - last) * 10) / 10,
            rows: counted(sub.now),
            groups: rows.length,
            holders: sub.holders.size,
          };
          last = at;
          console.log(JSON.stringify(line));
          for (const notify of sub.holders) notify(sub.now);
        },
        sub.ac.signal,
      );
      if (sub.ac.signal.aborted) break;
      // The stream ENDED without being aborted: an idle body timeout, a dropped
      // connection, or a terminal error record. Re-subscribe, because a subscription
      // that quietly stops being live is worse than one that fails — the numbers
      // stay on screen looking current. `tries` only counts while nothing has ever
      // arrived, so a healthy scope reconnects forever and a broken one gives up.
      if (sub.now === null && ++tries >= OPEN_TRIES) {
        subs.delete(key);
        console.error(`board-counts: no emission for ${key} after ${OPEN_TRIES} attempts`);
        return;
      }
      await new Promise((r) => setTimeout(r, REOPEN_MS));
    }
  })();

  return sub;
}

function acquire(ws: EntityId, viewer: EntityId): Sub {
  const found = subs.get(keyOf(ws, viewer));
  if (!found) return open(ws, viewer);
  if (found.idle) {
    clearTimeout(found.idle);
    found.idle = null;
  }
  found.refs++;
  return found;
}

function drop(sub: Sub): void {
  if (--sub.refs > 0 || sub.idle) return;
  sub.idle = setTimeout(() => {
    subs.delete(sub.key);
    sub.ac.abort();
  }, LINGER_MS);
  sub.idle.unref(); // a lingering subscription must not keep the process alive
}

/** One open board stream's claim on a tally. */
export interface CountsHold {
  /** Point this hold at a scope — subscribing if nothing is watching it yet — and
   *  answer with what is in memory for it. `null` means this scope has only just
   *  been subscribed and its first emission has not arrived; the render draws the
   *  chips without numbers and the push fills them in.
   *
   *  Called per PAINT, not once per stream, because a repaint can move a stream to
   *  a different viewer or workspace. */
  at(ws: EntityId, viewer: EntityId): { now: Counts | null };
  /** Let go. The subscription closes once the last holder has, and lingered. */
  release(): void;
}

/**
 * Take a hold, and say what to do when the tally moves under it.
 *
 * `onPush` is what makes the chips live: it fires on every emission AFTER the one
 * the holder already has, with no read behind it, so a write to a todo that is not
 * on this page still moves the numbers. Nothing else in this app is woken by a
 * change outside what it is looking at, and this is the one place that is right —
 * the chips are a statement about the whole workspace.
 */
export function holdCounts(onPush: (c: Counts) => void): CountsHold {
  let held: Sub | null = null;
  const listener = (c: Counts) => onPush(c);
  const letGo = () => {
    if (!held) return;
    held.holders.delete(listener);
    drop(held);
    held = null;
  };
  return {
    at(ws, viewer) {
      const key = keyOf(ws, viewer);
      if (held === null || held.key !== key) {
        letGo();
        held = acquire(ws, viewer);
        held.holders.add(listener);
      }
      return { now: held.now };
    },
    release: letGo,
  };
}
