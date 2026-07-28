# Handoff — todo-stardust on the playground VM

You are taking over an ongoing exploration. Read `AGENTS.md` in the repo FIRST and
in full — it is the accumulated, measured knowledge of this project and most of
what follows assumes it.

## What this is

A todo app whose real subject is Stardust: how much of an application can be
expressed as facts, queries and reactors instead of application code. The app is a
means of finding where that stops working. Findings matter as much as features.

## Where things are

- Repo: `~/dev/github.com/derekr/ideas/todo-stardust` — **this VM is the source of
  truth**, not any laptop copy. Pushed to `github.com/derekr/stardust-todos`.
- Stardust: `http://127.0.0.1:3010` (currently **0.0.8**), db under
  `~/stardust/data/todo-stardust/`, releases in `~/stardust/releases/<version>/`
  with docs under `docs/`. Read those docs — they are the reference, and they are
  occasionally wrong (a link target in the tutorials does not exist in 0.0.6+).
- App: `http://127.0.0.1:8000/todos-app/`, public `https://stardust.exe.xyz/todos-app/`.
  Unit `app@todo-stardust`; Stardust unit `stardust@todo-stardust`.
- Node needs `export PATH=$HOME/.local/share/mise/shims:$PATH`.
- Version switching: edit `STARDUST_VERSION` in
  `~/stardust/instances/todo-stardust.env`, restart the stardust unit.

## Rules that exist because they caught real bugs

1. **`systemctl --user` needs `export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"`.**
   Without it the restart silently fails and you verify the OLD process. This has
   happened more than once. Restart LAST, then verify, and confirm MainPID moved.
2. **A timing without a row count is not evidence.** A query matching nothing is
   fast; a clause that filters nothing is also fast; a bind matching no session
   returns `[]` in milliseconds. All three produced confidently wrong conclusions
   that reached commit messages. Assert row counts, always.
3. **Use the app's own instrumentation**, not curl wall-clock: `?debug=1` appends
   the request record, `/inspect/timings.json` holds the last 60,
   `journalctl --user -u app@todo-stardust | grep '"t":"req"'`. Note plain curl
   never holds an SSE stream, so anything keyed to a live stream looks cold to it —
   that hid a bug for hours.
4. **`npm run check` — read the tail, do NOT grep it** for expected words. A
   failing gate was committed that way.
5. **Verify STORED reactor bodies** via `/xray/ron/<name>` or
   `GET /reactors/{id}` with `Accept: application/x-ndron`. `ensureReactor`
   silently ignores a removed key and once dropped a column while reporting success.
6. **NEVER `pkill -f "port NNNN"`** — it matches its own command line and kills your
   shell. Kill by PID, and killing a `setsid` wrapper is not killing the server.
   Start throwaways as their own ssh call:
   `setsid ~/stardust/releases/0.0.8/bin/stardust --port NNNN --clear-db --db /tmp/x.stardust </dev/null >/tmp/x.log 2>&1 & disown`
7. **Prototype against a throwaway, never `:3010`**, unless you are only reading.
8. Commit with jj in the repo's prose voice (read `git log` — full sentences on why
   and what was measured, not bullet lists), ending
   `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
   `jj describe -m "$(cat msg)"`, `jj bookmark set main -r @`,
   `jj git push --bookmark main`, `jj new`. **Then confirm `git rev-parse main`
   actually moved** — a commit was made once without the bookmark following it.

## Current state

Stardust **0.0.8**, fresh database, ~10,001 todos seeded. Board ~120ms first paint,
filters 20–65ms, detail ~70ms. `npm run check` green (26 tests). `npm run stress`
was last run green at 2,000 **against 0.0.6** — see open items.

The architecture, briefly: filters live in the URL, not the database. Rows are a
per-page dry-run with filters inlined as literals. `blocked`, `effectiveStatus`,
`prank`, the `tags` list component and `tagVocab` are stored facts written by the
transaction that causes them, each with a reconcile guard. Liveness is a
subscription over just the rows on screen (`page-rows`), plus one per
(workspace, viewer) for the count chips. Commands are entities; the role gate and
state applicability are both clauses in the query, so the menu and the write
boundary cannot drift.

## Open items, roughly in priority order

1. **Run `npm run stress --n 2000` against 0.0.8.** Not yet done since the upgrade.
   This is the thing most likely to surface semantic drift the changelog omitted.
2. **The reconcile guards are never run.** `reconcileBlocked`, `reconcileTags`,
   `reconcileTagVocabulary` each guard an invariant that moved from "guaranteed by
   the query" to "guaranteed by write discipline". Nothing executes them routinely.
   Wiring them into the gate (~131ms at 10k) would convert four hopes into checks.
3. **Two unresolved contradictions.** Does anything actually use `Tx-Check-Last`?
   One investigation said nothing does, another said `patchTodo` writes under it.
   And `?pr=high,low` returns the same rows as `?pr=high` — probably legitimate
   (high fills all 50 slots) but it is also exactly what a broken union looks like,
   and the harness does not distinguish them.
4. **Time is the big unused capability.** This is a fact database where every fact
   carries its transaction and the app surfaces almost none of it. Both of these
   were measured working and then routed around: `bind.with.db.asOf` (real temporal
   snapshots — the snapshot-search UX: pin a session to a transaction, pages stay
   stable, "records changed → reload" is comparing your asOf to the latest tx) and
   `bind.with.facts` (transient overlays that persist nothing — genuine what-if
   previews with no write). Either is more interesting than more milliseconds.
5. **Perf levers left deliberately unpulled**, with numbers in AGENTS.md: a stored
   `prank`-then-title composite ordering key (~47ms → ~6ms on the unfiltered board,
   but it is a schema property, an index, a backfill and another write-path
   invariant); and keyset pagination, which the body is now eligible for but which
   trades addressable page numbers for opaque cursors.
6. **`migrateOrphanTodos` uses `not`**, which is a subquery capped at 1,000 rows, so
   it throws above 1,000 todos. Worked around, not fixed.

## How to work here

Prototype with curl against a throwaway before touching app code — it is faster and
unambiguous, and app-level testing hides things (live board updates were broken for
a while and every test passed, because each test opened a FRESH stream and the bug
only existed for an already-open one).

Treat this file, AGENTS.md, and the code comments as claims to test rather than
ground truth. Several confidently-stated entries in them have been overturned by
measurement, including entries written after measurement. When you overturn one,
correct it in place and say what the evidence was.

When you make a judgement call — a trade between speed and clarity, engine and app,
data and code — record which way you went and why in the commit message. A reversed
decision is fine; an unrecorded one gets made again.
