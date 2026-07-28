# todo-stardust

A todo app backed by [Stardust](http://localhost:1980/docs/) facts, with **two frontends** —
a CLI and a **Datastar** web UI. Both read a *reactor*, and Stardust pushes the new
result when one changes, so a todo written from either side turns up in the other
without anything polling. They do not share a reactor: the web board subscribes to
the fifty rows it is showing (`page-rows`, bound per open stream) and to the count
chips' whole-workspace tally (`board-counts`, bound per workspace and viewer), the
CLI reads its workspace's own.

Nothing in the app watches for changes. Every live update is a Stardust
subscription re-emitting — see [AGENTS.md](./AGENTS.md) for what that does and does
not cover.

Written in TypeScript, run natively by Node 22+ (no build step). One dependency:
the Datastar TS SDK (for the SSE wire format).

## Setup

```sh
npm install                       # installs @starfederation/datastar-sdk
./scripts/vendor-assets.sh        # datastar + IBM Plex into public/ (once)
# point at a throwaway Stardust DB:
export STARDUST_URL=http://localhost:1981
npm run stardust:setup            # provision the named reactors
```

The browser assets are vendored rather than pulled from a CDN: the page's content
arrives over the reactor stream, and a third-party script in front of that stream
gates first paint. The web UI also server-renders the first board into the HTML,
so nothing flashes in — Datastar morphs its first patch over identical markup.

On first run the app creates a `Todo` JSON Schema and caches its id in
`.state.json` so later runs reuse it.

Reactors are provisioned by NAME, not cached: `npm run stardust:setup` creates
each one, or updates it if its definition has drifted, or leaves it alone —
re-running is free. The app does the same check on boot, so the setup script is
only about making a deploy fail there rather than on someone's first request.
This matters because a reactor is stored state: the board reactor used to be
created per process, so every restart left another live one behind.

## CLI

```sh
node src/cli.ts add "Buy milk" --priority high
node src/cli.ts add "Write the README" -p low
node src/cli.ts ls
node src/cli.ts done 780        # or: undone / toggle
node src/cli.ts rm 783
node src/cli.ts watch           # live-redrawing list, driven by the reactor
```

## Web UI (Datastar)

```sh
node src/server.ts              # open http://localhost:3000
```

Open it in two tabs and add/complete todos — they update in both at once.
Run `node src/cli.ts add "..."` in a terminal and watch the browser update too.

## How it maps to Stardust

| Todo action        | Stardust operation                                            |
|--------------------|--------------------------------------------------------------|
| create             | `POST /schemas/{id}/entities` — one validated write carrying `workspace` + `app` |
| complete / reopen  | `PATCH /schemas/{id}/entities/{id}` with `{ done: true|false }` |
| delete             | `DELETE /entities/{id}` (retracts every field)               |
| the live list      | a **reactor** (`find`/`where`/`then.project`) read as a record stream — `page-rows` for the web board, a per-workspace reactor for the CLI |
| the board's rows   | a one-shot **dry-run**, built per read from the filter in the URL (`src/board-query.ts`) |
| the count chips    | a **subscription** per (workspace, viewer) — `board-counts`, held in memory and pushed, never read per render (`src/counts.ts`) |
| the tag chips      | one **fact** on the workspace — `tagVocab`, maintained by the tag writes and guarded by `reconcileTagVocabulary()` (`src/tags.ts`) |

## Multi-tenancy: user → persona → workspace

The app started single-tenant and grew data-isolated multi-tenancy **without a
rewrite** — see the jj history (`jj log`). The model is plain facts:

- **user** — a login (email). Has one or more **personas**.
- **persona** — a "hat" (Work / Personal); the principal that owns/joins workspaces.
- **workspace** — the **data-isolation boundary**; todos live in exactly one.
- **grant** — an edge fact `(persona, workspace, role)`. Access = a grant exists.

### Leak-safe by construction — three independent layers

1. **Types.** Every todo read/write requires a `WorkspaceCtx`, and the only way to
   get one is `openWorkspace(persona, workspace)`, which runs the grant check first.
   "Forgot to scope by tenant" is unrepresentable — it won't compile.
2. **Reads.** Reads go through a query whose scope is fixed server-side — the
   per-workspace reactor (CLI) is pinned to `[?t workspace {# id}]` at workspace
   creation, and the board (web) inlines its workspace and viewer as literals from
   the server's own state. The URL carries what to NARROW to and never what scope
   to read in, so no query string can widen it. Stardust also does the ordering and shapes the output (`then.project`
   returns `{id,title,done,priority}`), so there's no positional mapping to get wrong.
3. **Writes.** `authorizeWrite` re-checks ownership before every mutation, so a
   stray cross-tenant id can't be toggled or deleted even if it reached the server.

### Did we need to migrate legacy data? (a verified finding)

Tempting answer: no — make the default workspace's reactor *adopt* legacy
single-tenant todos (those with no `workspace`) at read time via
`or(owned, not-workspace)`, rewriting nothing. **We tested it and it LEAKS:** `or`
combined with `not` over-matches and pulls another workspace's todos into the
result. So for a security boundary the scope stays a **single pinned clause**.

The honest conclusion: to bring legacy data into a workspace you *do* assign it a
`workspace` — but in Stardust that "migration" is just **asserting one fact per
row** (`migrateOrphanTodos`): additive, non-destructive, history-preserving, and
reversible — never an `ALTER TABLE`. The default workspace backfills once at
first boot; isolated workspaces never touch it.

## Evolution stages (see `jj log`)

The app grew far past its original design without a rewrite. Each stage is a
commit; `jj log` is the record:

| Stage | What was added | Stardust idiom |
|-------|----------------|----------------|
| 1 | single-tenant todos | schema + reactor + SSE |
| 2 | multi-tenancy | per-workspace pinned reactors, capability types |
| 3 | status, tags, dependencies | tags/deps as **edge entities**; graph joins |
| 4 | derive-on-read | correlated `exists` bound to a var, so a DERIVED value is filterable |
| 5 | one query, every filter | ONE body computes effectiveStatus + every filter server-side |
| 6 | it has to scale | derived facts recorded on WRITE; the board returns one PAGE |
| 7 | filters read, not joined | selected facet values compiled into the body as literals |
| 8 | state split by lifetime | the filter is the URL; only the fifty rows on screen are facts |

Highlights of the later stages:

- **Rich fields nobody planned up front** (`src/features.ts`). Tags and
  dependencies are **edge entities** (like `grant`), so membership and graph
  questions are plain datalog joins rather than array gymnastics — with one
  exception the entry below explains, because "membership as a join" is exactly
  what the board's tag filter could not afford. Due dates are
  Stardust instants, queried with a field predicate (`[< ?due {#utc now}]`) in
  the board's `overdue` clauses.
- **Derived state, no worker** (`src/board-query.ts`, `src/derive.ts`, `src/todos.ts`).
  Blocked-ness and the derived views used to be materialized onto `status` by a
  background worker reacting to the transaction bus. They became DERIVED on read by
  a correlated `exists` bound to a variable inside the board reactor — and for
  `blocked` that has since been reversed, because a correlated subquery runs per
  row against a budget of 10,000 executions shared by the whole query. It is stored
  again, written by the transaction that causes it (`refreshDerived`), and checked
  against the plain query by `reconcileBlocked`. Still no worker: the writer is the
  request that caused the change, not a process watching for work.
- **The board is one page** (`src/board-query.ts`). `limit`/`offset` on the body, fifty
  rows shown and a fifty-first read only to know whether there is a next page —
  which is why the pill says `50+` rather than a total. Worth knowing what that did
  and did not buy: `limit` is a POST-FILTER. At 2,000 unindexed todos the plain
  board costs 7.6s unlimited, 7.5s with `limit 50`, and 7.5s for a bare count over
  the same `where`, so paging bounds the response and the render, not the query,
  and a "showing 50 of N" pill would have doubled the work of every page view.
- **What a page view actually costs** (`src/board.ts`, `src/server.ts`). Paging the
  board did not make the page fast, because the reads beside it were still
  whole-workspace. At 10,003 todos one board URL was ~280ms; it is ~62ms now, and
  none of the things that got it there was the rows query being clever:
  * A **filter that filtered nothing.** An empty facet selection compiled to an `or`
    over its whole domain — a comparison every row passes, seven of them per row.
    Deleting both: 85ms → 54ms for one page, byte-identical rows.
  * A **bind is not a literal.** The counts body read through a stored reactor with
    `?ws`/`?viewer` costs 197ms; the same body as a dry-run with both inlined costs
    132ms. The fact-clause bind is ~28ms of that and the expression bind ~51ms.
    That is a price PER READ, and it reverses for a subscription — see the tally
    below, which pays it once and is a stored reactor again because of it.
  * **An unbounded read behind a bounded UI**, for the third time in this repo. The
    ⊘ badges used to read every dependency edge in the workspace (34ms) to decorate
    fifty rows; they read the ids on the page now (9ms, or no read at all when
    nothing on the page is blocked). The membership set holds REFS — bare ids match
    nothing, fast and silently.
  * The **tally stopped being a read at all.** It is the one number that has to be
    whole-workspace, and at 132ms it was most of the page. It first moved off the
    critical path — the render sent the rows and patched the numbers when they
    landed — and it is a SUBSCRIPTION now (`src/counts.ts`): one per (workspace,
    viewer) in use, whose latest emission is held in memory, so a paint reads a
    field and issues no query. The chips are the one thing on the board a reader
    cannot change, so nothing a reader does can invalidate them; only a write can,
    and that is what the engine already watches for. Measured through the app's own
    instrumentation over fifteen navigations at 10,003 todos, the counts read is in
    none of the request records and the ~190ms subscribe was paid once: a paint went
    170ms → 65ms unfiltered, 191ms → 38ms on `?pr=high`, 167ms → 72ms on
    `?st=blocked`. The server-rendered document reads that same field, so a page turn
    and a filter click ship the numbers in the HTML the browser blocks on; the pill
    reads `50 · …` only on a scope nothing is watching yet, for the length of one
    subscribe — 246-273ms here, against 75-96ms for the rest of the page, which is
    why that one paint waits rather than counting in front of the reader. It also
    made the numbers LIVE —
    a write to a todo that is not on the page you are reading moves them now, where
    before only a repaint could.
  * The **tag vocabulary stopped being an aggregate**, which is the same problem with
    the opposite answer. `groupBy` over 4,246 tag edges, 29.5ms per render for the
    same ten labels; it is a fact on the workspace now, 5.3ms, maintained by the tag
    writes rather than by a subscription — because a vocabulary changes when a label
    is first used or last removed and otherwise never, while a tally changes on every
    write. Materialise what changes rarely, subscribe to what changes often.
  * **A page past the end costs a whole board and returns nothing.** `?p=200` was
    285.9ms and 303.0ms for 0 rows in the traces, because `offset` is applied after
    the work. The tally in memory is an upper bound on every filtered subset of the
    board, so one comparison answers it with no read at all: 343.2ms → 0.0ms.
- **Clause order is the plan** (`src/board-query.ts`). Once the page was ~95ms the
  next thing the instrumentation showed was that a FILTERED board cost far more than
  an unfiltered one: `?st=blocked` was 249ms against 94ms, and 143 of the 154ms sat
  in one read that returned the same 51 rows. Stardust evaluates a `where` in the
  order it is written and does not reorder it, so the facet filters — expressions at
  the END of the body, over vars the base clauses had bound — meant every read walked
  the whole workspace in `prank` order and discarded rows. 124 of 9,947 todos are
  blocked, so that walk was long. Writing `[?t effectiveStatus blocked]` FIRST costs
  27ms instead of 193ms for byte-identical rows, and the same move is worth
  something on every filter the board has, dense ones included: `?st=blocked&pr=high`
  262 → 29ms, `?v=mine` 49 → 24ms, `?tag=design` 47 → 24ms, `?st=todo` (69% of the
  corpus) 52 → 33ms, no filter unchanged at 54ms. End to end through the app,
  `?st=blocked` is 242ms → 74ms.
  A second finding rode along: what an `orderBy` costs is its LEADING key's
  cardinality, not how many keys it has. `[?title ?prank]` is 6ms and `[?prank
  ?title]` is 47ms on the same board — a three-value key cannot drive an
  index-ordered scan. So when the filter pins one priority, `prank` is constant,
  ordering by it is a no-op, and dropping it takes `?pr=med` from 184ms to 6ms with
  the rows in exactly the same order.
- **A ratio is a diagnosis** (`src/history.ts`). The detail page's activity feed was
  44ms for 17 rows — one facts read plus one HTTP round trip PER ROW for the
  transaction entities that carry the commit time and the actor, eighteen requests to
  render the eight lines the pane shows. It reads the newest eight now and attributes
  all of them in ONE dry-run over the transaction entities: 11ms, and the detail page
  91ms → 60ms. Two engine details made that query work: the membership test has to be
  an `or` of `[= ?tx {# N}]`, because `[contains {#set …} ?tx]` against a
  subject-position var matches nothing at all, and `or` is a macro whose expansion is
  capped around twelve branches.
- **The filter is the URL** (`src/filter.ts`, `src/board-query.ts`). It used to be
  facts: an `sf` child per selected value on a per-browser `session` entity, with a
  `/s/<sid>` link naming it. It became a query string in two steps, and both are
  worth reading before you put per-user state in a database. First the query stopped
  JOINING those facts and started being BUILT from them — at 5,005 todos with value
  indexes on, one page of fifty, 51ms with no filter at all, **1,972ms** joined,
  **24ms** inlined, because a literal narrows the candidate set while a join adds
  work proportional to it. Then the facts went, because inlining had already taken
  the engine out of evaluating them: the app was reading them back and compiling
  them in, which is a parameter, not state the database was doing anything with.
  Three measurements finished it. A filter write **re-emitted nothing** (the live
  subscription watches the rows on screen and has no `sf` clause), so the repaint had
  always come from the server aborting its own SSE stream and re-opening it. The
  facts **cost ~46 per click and ~129 per session** on an append-only store, and that
  churn taxes unrelated writes forever — a three-fact todo patch went 4ms → 9ms →
  17ms as the database grew from 7.5k to 369k facts it never touches. And `/s/<sid>`
  **shared a mutable session**, so two people on one link overwrote each other's
  filters. A URL gives each of them their own view, makes back and forward work, and
  makes a filtered board a thing you can bookmark. What it costs: the filter is
  INPUT now, so every value is checked against its domain and an unknown one is a
  400 rather than a dropped clause — dropping widens the board, which is the failure
  you do not notice. Tag labels have no fixed domain, so they are checked against the
  workspace's actual tag vocabulary instead.
- **Tags are stored three times, on purpose** (`src/tags.ts`, `src/features.ts`). A
  tag is still an edge ENTITY — the source of truth the other two derive from — and the
  todo now also carries its labels as a list component of its own, written by the
  same transaction as the edge. The board filters on the component, and the reason is
  not speed but a hard failure: filtering on the edges meant a correlated `exists`,
  and a subquery's OUTPUT is capped at 1,000 rows per directive, so on the 10,003-todo
  demo `?tag=design` took 82.7s, `?tag=design,launch` 77.7s, and `?tag=design,launch,api`
  was refused outright and rendered as an empty board — the worst kind of wrong,
  because a filter matching nothing looks like an answer. Two plain clauses replaced
  it (bind the todo's list, then `[contains {#set […]} …]` over it): 84ms at ten
  thousand todos, flat in the number of labels, each todo returned once however many
  selected labels it carries. What it gives up is the same trade `blocked` made —
  the invariant is now write discipline plus `reconcileTags()`, which asks both
  questions plainly and reports every todo where the two disagree.

  The third copy is the **vocabulary**: which labels the workspace uses at all, which
  is what the chips are drawn from and the only domain a `?tag=` in a URL can be
  checked against. It was a `groupBy` over 4,246 edges on every render — the same ten
  rows every time, 29.5ms of a 95ms board — and it is one fact on the workspace
  entity now, read in 5.3ms. Four other shapes were measured and lost: the stored
  reactor with a bind (32.7ms), the same body inlined (28.9ms), `workspace`
  denormalised onto the edge (17.5ms), and ten interned `labelDef` ENTITIES (8.1ms),
  which would also have needed a join wherever a label string is used and would list
  labels nothing carries any more. Holding it in memory like the tally would be 0ms
  and is the one this deliberately refuses: a tally moves on every write, a
  vocabulary moves when a label is first used or last removed, and a fact survives a
  restart, is visible to every process, and is queryable. Materialise what changes
  rarely, subscribe to what changes often.

- **The blocker picker searches, through a second index on the same field**
  (`src/board.ts`, `src/indexes.ts`). "Add blocker" used to offer every visible
  todo — 9,947 buttons, a 686KB read, 307ms of a 361ms detail page — and bounding
  it to the first 25 by title fixed the cost and left a control that could not
  reach a blocker further down the alphabet. It has a search box now, debounced in
  the browser and answered by one `fts` clause. `title` carries an analyzed english
  TEXT index alongside its value index; the two are independent policies on the
  same `/indexes/title` document, so enabling one is a `PATCH` that leaves the
  other alone. What that buys over the value index the field already had: a range
  read (`[>= ?title 'Buy'] [< ?title 'Buz']`) matches a PREFIX of the whole title,
  and every meaningful word in this data is in the middle of one — "landing" would
  never find `① Design landing page`. `fts` matches stemmed TERMS wherever they
  fall, so "land" finds it too. Measured against the demo's 10,003 todos: 3ms for a
  term matching four rows, 11ms for one matching 625, 42ms for one matching 2,498,
  and the detail page stays at ~81ms while the search is idle. The bound that
  matters is the TERM, not the `limit` — the documented top-k shape really is one
  (4ms against 17ms unlimited) but only while the fts clause is the whole query,
  and this one joins workspace and visibility clauses back on. Enabling the
  analyzer over 10,003 titles took 3.6s inside the `PATCH`, built 49,880 postings,
  grew the database from 32.2 to 48.4 MiB, and costs a title write 2.7ms against
  1.8ms.
- **Every rendered request says where its time went, with the row counts**
  (`src/timing.ts`, `/inspect`). One JSON line per request on stdout — route, filter
  shape, total, render time, and each read with the number of ROWS it produced. The
  row count is not optional and cannot be omitted: `Trace.read` takes the work and a
  function that counts what came back, so a read that cannot say what it returned
  cannot be timed. That is aimed at one specific failure this project kept having —
  a read that matched nothing is fast, and from outside it looks exactly like a read
  that was quick. `?debug=1` returns the same record in the response as an HTML
  comment (the same document a browser gets, so the numbers are about the real code
  path), `/inspect` shows the last 60, and `/inspect/timings.json` is the machine
  form — the only way to see the SSE repaints, which no `curl` timing can separate.
  It costs 5.4µs a request and nothing it records is ever written to Stardust.
- **One reactor = the source of truth for the UI.** Commands (add/toggle/remove) only
  *write facts*; they never render the list. The reactor recomputes and Stardust
  pushes the new result down the open record stream, so every connected client
  re-renders. This is exactly Datastar's
  CQRS pattern — long-lived read stream, short-lived command posts.
- **The server holds no per-user filter state.** A browser's filter is its own URL,
  decoded and compiled into the query per read, so two tabs — or two people on one
  link — filter independently and the process keeps nothing. (It does keep the
  active workspace and the "view as" persona. Those were always server state, and
  pretending otherwise was the part of this claim that was never true.)
- **Two streams meet in the middle.** Stardust's reactor results arrive as an
  NDJSON **record stream** (0.0.6 dropped machine SSE) → the Node server →
  Datastar `patch-elements` SSE → the browser DOM. The server (`src/server.ts`,
  `/stream`) is the bridge.
- **Pure JSON to Stardust.** `src/stardust.ts` uses only `fetch` and a streamed `fetch`
  body — no driver, no RON. Writes are JSON Merge Patch; the schema is JSON Schema.

## Files

- `src/stardust.ts`      — tiny Stardust 0.0.6 client (NDJSON record streams, tx bus, causation).
- `src/tenancy.ts`       — users, personas, workspaces, grants; per-workspace reactors.
- `src/workspace.ts`     — `WorkspaceCtx` capability, `openWorkspace` (access gate), default tenant.
- `src/todos.ts`         — workspace-scoped schema (evolved 3×) + commands + projected reads.
- `src/features.ts`      — tags & dependencies (edge entities); a tag write records both halves.
- `src/tags.ts`          — the tag component the board filters on, its label rule, its backfill and its reconciliation guard.
- `src/derive.ts`        — the correlated `exists` fragments (blocked, visibility).
- `src/filter.ts`        — the Filter ⇄ query-string codec, and the domains every value is checked against.
- `src/board-query.ts`   — compiles one filter and one page into the board's body; runs it as a dry-run.
- `src/pageset.ts`       — the fifty rows an open stream is showing, as facts, so a reactor can name them.
- `src/counts.ts`        — the count chips' tally, held open per (workspace, viewer) instead of read per render.
- `src/queries.ts`       — the declared reactors (one definition each, typed readers out).
- `src/indexes.ts`       — field-index policy: value indexes for the fields those reactors key on, and the english text index behind the blocker picker's search.
- `src/commands.ts`      — commands as entities; the role gate lives in the query.
- `src/cli.ts`           — the CLI (operates in the default workspace).
- `src/server.ts`        — Node HTTP + Datastar web server (CQRS + workspace switching).
- `src/view.ts`          — server-rendered HTML: `#wsbar` switcher + morph-friendly `#list`.
- `src/timing.ts`        — per-request timings; a read is timed only together with its row count.
- `src/xray.ts`          — the in-situ "how is this resolved?" overlay.
- `src/inspect.ts`       — the glass box: commit feed, fact provenance, log replay, and where each request's time went.
- `src/app.test.ts`      — unit tests for the pure query/derivation helpers.
