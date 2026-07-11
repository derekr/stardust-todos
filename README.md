# todo-stardust

A todo app backed by [Stardust](http://localhost:1980/docs/) facts, with **two frontends** —
a CLI and a **Datastar** web UI — that stay in sync **live**. Both render the same
Stardust *reactor* stream, so a change from either side (or another browser tab) shows up
everywhere instantly.

Written in TypeScript, run natively by Node 22+ (no build step). One dependency:
the Datastar TS SDK (for the SSE wire format).

## Setup

```sh
npm install                       # installs @starfederation/datastar-sdk
./scripts/vendor-assets.sh        # datastar + IBM Plex into public/ (once)
# point at a throwaway Stardust DB:
export STARDUST_URL=http://localhost:1981
```

The browser assets are vendored rather than pulled from a CDN: the page's content
arrives over the reactor stream, and a third-party script in front of that stream
gates first paint. The web UI also server-renders the first board into the HTML,
so nothing flashes in — Datastar morphs its first patch over identical markup.

On first run the app creates a `Todo` JSON Schema and a list reactor in Stardust,
then caches their ids in `.state.json` so later runs reuse them.

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
| the live list      | a per-workspace **reactor** (`find`/`where`/`then.project`) streamed over SSE |

## Multi-tenancy: user → persona → workspace

The app started single-tenant and grew data-isolated multi-tenancy **without a
rewrite** — see the jj history (`jj log`). The model is plain facts:

- **user** — a login (email). Has one or more **personas**.
- **persona** — a "hat" (Work / Personal); the principal that owns/joins workspaces.
- **workspace** — the **data-isolation boundary**; todos live in exactly one.
- **grant** — an edge fact `(persona, workspace, role)`. Access = a grant exists.

Run the isolation proof (12 assertions):

```sh
node src/demo-tenancy.ts        # npm run demo:tenancy
```

### Leak-safe by construction — three independent layers

1. **Types.** Every todo read/write requires a `WorkspaceCtx`, and the only way to
   get one is `openWorkspace(persona, workspace)`, which runs the grant check first.
   "Forgot to scope by tenant" is unrepresentable — it won't compile.
2. **Reads.** Each workspace gets its **own reactor**, pinned to a single clause
   `[?t workspace {# id}]`, created server-side at workspace creation. The client
   only ever holds the reactor **id** — never the filter — so it cannot widen the
   scope. Stardust also does the ordering and shapes the output (`then.project`
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
commit and a runnable proof:

| Stage | What was added | Stardust idiom | Proof |
|-------|----------------|----------------|-------|
| 1 | single-tenant todos | schema + reactor + SSE | `npm run web` / `cli` |
| 2 | multi-tenancy | per-workspace pinned reactors, capability types | `npm run demo:tenancy` |
| 3 | status, due dates, tags, dependencies | instant field predicates; tags/deps as **edge entities**; graph joins | `npm run demo:fields` |
| 4 | projects + duplicate | atomic **temp-id ref remapping** in one transaction | `npm run demo:projects` |
| 5 | durable workflows | event-bus dataflow: derive facts, apply across the write boundary, causation-linked | `npm run demo:workflow` + `npm run worker` |

Highlights of the later stages:

- **Rich fields nobody planned up front** (`src/features.ts`). Due dates are
  Stardust instants queried with a field predicate (`[< ?due {#utc now}]`).
  Tags and dependencies are **edge entities** (like `grant`), so membership and
  graph questions ("what's blocked?", "what's ready?") are plain datalog joins
  rather than array gymnastics. `ready` is a set-diff of two positive queries
  because Stardust's `not`/`or-not` don't compose safely (verified).
- **Projects + duplication** (`src/projects.ts`). `duplicateProject` clones a
  project, its todos, and the dependency/tag edges among them in **one
  transaction**, using temp-id references (`{"#":"_t<id>"}`) so Stardust rewires
  every dependency to the new copies atomically — no dangling cross-project refs.
- **Durable workflows** (`src/workflow.ts`, `src/worker.ts`). Per the theory —
  *reactors define and observe; writes still cross the write boundary* — a
  workflow is derivation rules (queries) + an applier that reacts to the
  transaction event bus. It auto-blocks/unblocks todos from the dependency graph
  and auto-closes/reopens projects, tagging each derived write with the causing
  transaction id (`Tx-Causation-Id`). It's idempotent, so it converges to a
  fixpoint and stops. Verified live: adding a dependency auto-blocks the
  dependent with no explicit call.
- **Workspace switching in the web UI** (`src/server.ts`, `#wsbar`). One active
  workspace at a time; switching updates the server context and closes streams,
  and Datastar auto-reconnects to re-render against the new workspace.

## Pushing work into Stardust (not over-guarding)

- Filtering, ordering, and **shaping** happen in the reactor (`where` + `orderBy`
  + `then.project`), not in TS.
- One schema write creates a reactor-ready todo (`workspace` + `app` are schema
  fields) instead of a create-then-tag pair.
- Stardust's expression engine is **bounded and fails closed** (AST depth, macro
  depth, higher-order fuel, output-list size — see docs `expressions/limits`), so
  it's safe to push aggregation/projection server-side without app-side guards.

## Why it's a clean fit (TS + Datastar + Stardust)

- **One reactor = the source of truth for the UI.** Commands (add/toggle/remove) only
  *write facts*; they never render the list. The reactor recomputes and Stardust pushes
  new results over SSE, so every connected client re-renders. This is exactly Datastar's
  CQRS pattern — long-lived read stream, short-lived command posts.
- **Two SSE streams meet in the middle.** Stardust reactor SSE → the Node server →
  Datastar `patch-elements` SSE → the browser DOM. The server (`src/server.ts`, `/stream`)
  is a ~10-line bridge.
- **Pure JSON to Stardust.** `src/stardust.ts` uses only `fetch` and a streamed `fetch`
  body — no driver, no RON. Writes are JSON Merge Patch; the schema is JSON Schema.

## Files

- `src/stardust.ts`      — tiny JSON-only Stardust client (fetch, SSE, tx bus, causation).
- `src/tenancy.ts`       — users, personas, workspaces, grants; per-workspace reactors.
- `src/workspace.ts`     — `WorkspaceCtx` capability, `openWorkspace` (access gate), default tenant.
- `src/todos.ts`         — workspace-scoped schema (evolved 3×) + commands + projected reads.
- `src/features.ts`      — tags & dependencies (edges); overdue/blocked/ready queries.
- `src/projects.ts`      — projects + `duplicateProject` (atomic ref remapping).
- `src/workflow.ts`      — durable-workflow derivation rules + event-bus worker.
- `src/worker.ts`        — runnable workflow worker (`npm run worker`).
- `src/cli.ts`           — the CLI (operates in the default workspace).
- `src/server.ts`        — Node HTTP + Datastar web server (CQRS + workspace switching).
- `src/view.ts`          — server-rendered HTML: `#wsbar` switcher + morph-friendly `#list`.
- `src/demo-*.ts`        — runnable proofs: tenancy (12), fields (9), projects (8), workflow (10).
