// Where a request's time actually went — measured by the server, not by curl.
//
// Every performance claim in this repo's history was taken from OUTSIDE with a
// stopwatch, and that is how three separate wrong answers got recorded as fact: a
// stale "the rows query is 416ms" survived long enough to shape a work brief when
// the cost was somewhere else entirely; a facet clause that filtered NOTHING looked
// cheap and was reported as a 1,270x win; and a bind matching no session returned
// `[]` in milliseconds, which went into a commit message as proof that the app path
// worked at ten thousand todos. Wall clock from outside cannot tell any of those
// apart, because all three are one number with no structure in it.
//
// So the unit here is not a duration, it is a duration WITH THE ROW COUNT BESIDE
// IT, and that is enforced by the only API this module offers. `Trace.read` takes
// the work AND a function that says how many rows the work produced; there is no
// overload that omits it and no `start()`/`stop()` pair to reach around it. A read
// that cannot say how many rows it returned cannot be timed by this helper, which
// is the whole design — "17ms" and "17ms, 0 rows" are different claims, and only
// the second one is evidence.
//
// `in` carries the other half of that, for a read whose cost is supposed to follow
// its input: `blockers` records how many ids it was ASKED about, so `rows 0 in 0`
// (no query was issued at all) reads differently from `rows 0 in 50` (the query ran
// and matched nothing). Those two look identical from outside and mean opposite
// things.
//
// What it costs to run: six `performance.now()` calls, an array push per read, one
// `JSON.stringify` and one `console.log` per request. Measured against the demo's
// 10,003 todos, first paint / a filter change / a page turn moved 74/86/78ms to
// 74/85/79ms — inside the run-to-run spread of the reads themselves. Nothing is
// written to disk and nothing is awaited: stdout under systemd is a pipe to
// journald, and the ring buffer is an array of at most RING_MAX plain objects.

/** One timed read, and how many rows it produced. There is no shape for a timing
 *  without a row count — see the header. */
export interface ReadRecord {
  read: string;
  ms: number;
  /** rows the read produced. The point of the exercise. */
  rows: number;
  /** rows it was asked ABOUT, where that is a different question — so "it matched
   *  nothing" and "it was never issued" can be told apart. */
  in?: number;
}

/** One rendered request, as one line of stdout and one row of `/inspect`. */
export interface RequestRecord {
  /** so `journalctl … | grep '"t":"req"'` finds exactly these lines */
  t: "req";
  seq: number;
  at: string;
  route: string;
  /** why this render happened — `open`, `push`, `viewas`… Blank for a plain GET.
   *  This is what makes "was that one repaint or three?" answerable. */
  why?: string;
  /** total wall time the server spent on this request */
  ms: number;
  /** of which, building HTML */
  render: number;
  /** the filter this request was for: facets, view, page, tag COUNT. Tag labels are
   *  free text from a browser, so the log records how many there were and never
   *  what they said. */
  shape: Record<string, unknown>;
  reads: ReadRecord[];
}

/** How many requests `/inspect` and `?debug=1`'s neighbours can look back over.
 *  Bounded on purpose: this app is careful about churn, and telemetry that grows
 *  is telemetry that eventually is the problem. Nothing here ever reaches
 *  Stardust — a request record is not a fact. */
const RING_MAX = 60;
const ring: RequestRecord[] = [];
let seq = 0;

/** The last N request records, newest first. */
export const recentRequests = (): readonly RequestRecord[] => ring;

const ms = (x: number): number => Math.round(x * 10) / 10;

/**
 * One request's timings. Create it when the request arrives, `read()` every query
 * through it, `render()` the HTML build, and `done()` once — which writes the line
 * and returns the record for `?debug=1`.
 */
export class Trace {
  readonly route: string;
  readonly why: string;
  private readonly t0 = performance.now();
  private readonly reads: ReadRecord[] = [];
  private renderMs = 0;
  private shape: Record<string, unknown> = {};

  constructor(route: string, why = "") {
    this.route = route;
    this.why = why;
  }

  /** What this request was filtered to. Set after decoding, because the tag
   *  vocabulary has to be read before the filter can be checked against it. */
  describe(shape: Record<string, unknown>): void {
    this.shape = shape;
  }

  /**
   * Time one read, and record what it returned.
   *
   * `rows` is a required argument and deliberately not defaulted: the caller is the
   * only one who knows what "a row" means for its result — the length of an array,
   * the todos a tally covered, the entries in a map — and a helper that guessed
   * would be a helper that could be silently wrong about the one number this exists
   * to produce.
   */
  async read<T>(name: string, work: () => Promise<T>, rows: (value: T) => number, input?: number): Promise<T> {
    const t = performance.now();
    const value = await work();
    const rec: ReadRecord = { read: name, ms: ms(performance.now() - t), rows: rows(value) };
    if (input !== undefined) rec.in = input;
    this.reads.push(rec);
    return value;
  }

  /** Time the HTML build. Called more than once per request on the stream path —
   *  a paint patches the board, then the chips — so it accumulates. */
  render<T>(build: () => T): T {
    const t = performance.now();
    const value = build();
    this.renderMs += performance.now() - t;
    return value;
  }

  /** Close the record: one line on stdout, one entry in the ring, and the object
   *  itself for `?debug=1` to hand back. */
  done(): RequestRecord {
    const rec: RequestRecord = {
      t: "req",
      seq: ++seq,
      at: new Date().toISOString(),
      route: this.route,
      ...(this.why ? { why: this.why } : {}),
      ms: ms(performance.now() - this.t0),
      render: ms(this.renderMs),
      shape: this.shape,
      reads: this.reads,
    };
    ring.unshift(rec);
    if (ring.length > RING_MAX) ring.length = RING_MAX;
    console.log(JSON.stringify(rec));
    return rec;
  }
}

/**
 * The record as an HTML comment, for `?debug=1`.
 *
 * A comment rather than a JSON body, and that is the point rather than a
 * convenience: `?debug=1` has to return the SAME response the browser gets, or the
 * numbers are about a code path nobody is served. An agent reads it with `curl -s
 * '…?debug=1' | tail -3`; a browser ignores it. (The SSE paints cannot carry a
 * comment, so they are readable at `/inspect/timings.json` instead — same records,
 * same ring.)
 */
export const debugComment = (rec: RequestRecord): string => `\n<!-- ${JSON.stringify(rec)} -->\n`;
