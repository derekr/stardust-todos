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
# point at a throwaway Stardust DB:
export STARDUST_URL=http://localhost:1981
```

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
| create             | `POST /schemas/{id}/entities` (validated) + open-world `app` tag |
| complete / reopen  | `PATCH /schemas/{id}/entities/{id}` with `{ done: true|false }` |
| delete             | `DELETE /entities/{id}` (retracts every field)               |
| the live list      | one **reactor** (`find`/`where`) whose results stream over SSE |

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

- `src/stardust.ts` — tiny JSON-only Stardust client (fetch + SSE).
- `src/todos.ts`    — domain layer: schema + reactor setup, commands, live `watchTodos`.
- `src/cli.ts`      — the CLI.
- `src/server.ts`   — Node HTTP + Datastar web server (CQRS).
- `src/view.ts`     — server-rendered HTML + the morph-friendly `#list` fragment.
