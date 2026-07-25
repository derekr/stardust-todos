# todo-stardust

A todo app backed by [Stardust](http://localhost:1980/docs/) facts, with **two frontends** —
a CLI and a **Datastar** web UI. Both read a *reactor*, and Stardust pushes the new
result when one changes, so a todo written from either side turns up in the other
without anything polling. They do not share a reactor: the web board reads one
canonical session reactor bound per browser, the CLI reads its workspace's own.

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
| the live list      | a **reactor** (`find`/`where`/`then.project`) read as a record stream — one canonical session reactor for the web board, a per-workspace reactor for the CLI |

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
2. **Reads.** Reads go through a reactor whose scope is fixed server-side — the
   per-workspace reactor (CLI) is pinned to `[?t workspace {# id}]` at workspace
   creation, and the canonical board reactor (web) takes its workspace and viewer
   from the session's own facts. Either way the client holds only an **id** —
   never the filter — so it cannot widen the scope. Stardust also does the ordering and shapes the output (`then.project`
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
| 5 | the session reactor | ONE reactor computes effectiveStatus + every filter server-side |

Highlights of the later stages:

- **Rich fields nobody planned up front** (`src/features.ts`). Tags and
  dependencies are **edge entities** (like `grant`), so membership and graph
  questions are plain datalog joins rather than array gymnastics. Due dates are
  Stardust instants, queried with a field predicate (`[< ?due {#utc now}]`) in
  the session reactor's `overdue` subquery.
- **Derived state, no worker** (`src/session.ts`, `src/derive.ts`). Blocked-ness
  and the derived views used to be materialized onto `status` by a background
  worker reacting to the transaction bus. They are now DERIVED on read by a
  correlated `exists` bound to a variable inside the board reactor, so nothing
  ever needs un-writing and the worker was deleted outright.
- **Workspace switching in the web UI** (`src/server.ts`, `#wsbar`). One active
  workspace at a time; switching updates the server context and closes streams,
  and Datastar auto-reconnects to re-render against the new workspace.

## Pushing work into Stardust (not over-guarding)

- Filtering, ordering, and **shaping** happen in the reactor (`where` + `orderBy`
  + `then.project`), not in TS.
- One schema write creates a reactor-ready todo (`workspace` + `app` are schema
  fields) instead of a create-then-tag pair.
- Even the command surface is data, and so is the permission check: commands are
  entities, and the viewer's RANK is a bind, so `[">=", "?rank", "?minRank"]` is a
  clause rather than a pass over the results. The ⌘K palette and the per-todo •••
  menu are ONE reactor read with `{scope … rank …}`, returning only what that
  persona may see; the write boundary asks a second reactor for one command at one
  rank, where an EMPTY result is the denial. Menu and permission cannot drift
  because neither re-derives the verdict.
- Stardust's expression engine is **bounded and fails closed** (AST depth, macro
  depth, higher-order fuel, output-list size — see docs `expressions/limits`), so
  it's safe to push aggregation/projection server-side without app-side guards.

## Why it's a clean fit (TS + Datastar + Stardust)

- **One reactor = the source of truth for the UI.** Commands (add/toggle/remove) only
  *write facts*; they never render the list. The reactor recomputes and Stardust
  pushes the new result down the open record stream, so every connected client
  re-renders. This is exactly Datastar's
  CQRS pattern — long-lived read stream, short-lived command posts.
- **The server holds no view state.** A browser's filter is facts on its own
  `session` entity, read back per render, so two tabs filter independently and the
  process keeps nothing. Writing a facet is what makes the reactor re-emit — there
  is no revision counter and no refresh call.
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
- `src/features.ts`      — tags & dependencies (edge entities).
- `src/derive.ts`        — the correlated `exists` fragments (blocked, visibility).
- `src/session.ts`       — the search session + the ONE canonical board reactor.
- `src/queries.ts`       — the declared reactors (one definition each, typed readers out).
- `src/indexes.ts`       — value-index policy for the fields those reactors key on.
- `src/commands.ts`      — commands as entities; the role gate lives in the query.
- `src/cli.ts`           — the CLI (operates in the default workspace).
- `src/server.ts`        — Node HTTP + Datastar web server (CQRS + workspace switching).
- `src/view.ts`          — server-rendered HTML: `#wsbar` switcher + morph-friendly `#list`.
- `src/xray.ts`          — the in-situ "how is this resolved?" overlay.
- `src/app.test.ts`      — unit tests for the pure query/derivation helpers.
