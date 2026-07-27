# Working on this app

A todo app whose real subject is Stardust: how much of an application can be
expressed as facts, queries and reactors instead of application code.

## Prototype against Stardust with curl, not through the app

When you are working out a query, a write shape, or what a reactor does, talk to
Stardust directly first. Two reasons, both learned the hard way here.

**It is faster, and unambiguous.** "Does a bound reactor re-emit when a session's
revision counter changes?" was murky for an hour through the app. One script
against port 3010 settled it in a minute — and the answer was no, the counter did
nothing; the facet write was already the trigger. That deleted a field, a schema
property, two functions and a reactor clause.

**App-level testing hides things.** Live board updates were broken for a while and
every test passed, because each test opened a FRESH stream and the initial paint
always worked. The bug only existed for an ALREADY-OPEN stream. If you are testing
liveness, hold a subscription open and write from somewhere else.

A throwaway server, so you never prototype against the demo's data:

```sh
~/stardust/releases/0.0.6/bin/stardust --port 3079 --clear-db --db /tmp/probe.stardust
# ready when this answers:
curl -sS -H 'Accept: application/x-ndjson' 'http://127.0.0.1:3079/healthz?max=1'
```

Things that will otherwise cost you a confused half hour:

- Every machine route needs `-H 'Accept: application/x-ndjson'`. Ask for
  `application/schema+json` on a schema READ and you get a bodyless 406 — that
  media type is for sending a schema, not reading one back.
- Live routes (`/entities/{id}`, `/reactors/{id}/results`, `/healthz`) never end.
  Add `?max=1` for a one-shot read.
- `PATCH /reactors/{id}` wants `application/json`; it rejects merge-patch.
- Ids come back as refs — `{"#": 12}` — including the `tx` on a fact row.
- Failures are a terminal record, `{"stardust/error": true, code, message}`, not
  only an HTTP status.

## Assume Stardust can carry more than you think

Default to asking whether the engine can hold something before writing code that
holds it. What that has already removed:

- A 194-line bus subscriber that watched every commit and decided what was
  relevant. The reactor pushes its own result; the query already said what matters.
- All server-side filter state. Filters are facts on a session, so two browsers
  have two filters and the server holds none. Note what that does NOT settle: the
  filter being a fact says nothing about how it reaches the query. It was a JOIN
  for a long time and it is now READ AND INLINED, which was worth 82x — see the
  entry in the tension section.
- A revision counter used to force re-emits. Writing the facts re-emits.
- Per-render dry-runs, promoted to stored reactors read with a per-call bind, so
  one reactor serves every workspace, viewer and todo. Partly REVERSED for the
  board, and for a reason worth carrying: a stored reactor is only a fit when the
  body is fixed and every input can be a bind. The board's body varies with the
  filter, so it went back to a dry-run — which cost nothing, because reading a
  stored reactor with a bind was already about the same price as a dry-run (27ms
  vs 29ms on the demo data).

Derived state especially: prefer computing on read (a correlated `exists` bound to
a variable) over materialising a field and then having to un-write it — but read
the entry on `blocked` in the tension section before you apply that to a field
whose subquery runs per row. That is the one place this rule has been reversed,
and it was reversed by measurement.

## What a subscription pushes, and what it does not

Nothing in the app watches for changes, so this line is the app's liveness
contract. It is measured, not assumed, and the README points here for it.

**Top-level clauses push — including for entities that did not exist yet.**
Writing a field named in the reactor's top-level `where` re-emits: a priority
change, a status change, a retraction and a publish each produced exactly one
emission. So does a brand-new ENTITY that those clauses match. Creating a
`command` fact set pushed to an open `command-menu` subscription immediately, with
nothing watching the commit bus, and so did changing an existing command's
`minRank` — which is what makes "changing access is a fact write, not a deploy"
literally true. Expression clauses in the body do not suppress this: that reactor
computes `enabled`/`visible` with `>=` and `or`, and still woke on both writes.

**That push is bind-scoped.** Two subscriptions on that one reactor, `{scope
'global'}` and `{scope 'todo'}`, were woken separately: a new global command
emitted on the global stream and the todo stream stayed silent. A bind is the
subscription's scope, not a client-side filter over a shared firehose — which is
what makes one stored reactor serving many callers sound.

**The gap is what only enters through a bound `exists`.** Adding a TAG to a todo
pushed nothing to the board reactor — verified from a background script, and again
with the tag filter active, so even an edge that changes which rows match was
invisible. Adding a DEP does push (measured twice). Both reached the board only
through a bound `exists`, so "subqueries don't invalidate" is the wrong lesson.
The rule that has never missed is the first one: reason about what appears as a
top-level clause. If liveness matters for a fact, put it there.

**And a query that is not a reactor pushes nothing at all, which is a liveness
decision and not only a performance one.** The board's rows are a dry-run now, so
NOTHING about the filtered set is live; the app's only board subscription is
`session-page`, which watches the fifty rows on screen. That is deliberate — a
subscription over the whole filtered set pushes membership churn at you while you
are reading — but it means every write the app makes that changes WHICH rows
belong (a filter, a page) has to re-open the stream by hand (`remount` in
server.ts). Forgetting that is silent: the board simply keeps showing the previous
answer. It has happened once already, and no test caught it, because every test
opens a fresh stream.

## An omitted bind is usually silent, and once is not

Stardust rejects a bind var NAME it does not know (`unknown bind var ?scoop`).
What it does with an ABSENT bind depends on where the var is read, and the
difference decides whether a forgotten argument is loud or dangerous.

**In a fact clause, an absent bind matches everything.** `["?c", "scope",
"?scope"]` binds `?scope` by scanning, so omitting it returns both scopes,
ordered, looking perfectly healthy. This is the trap: the failure is a superset,
not an error. Guard it by not exporting the `Declared` and taking the value as a
required function argument, so the compiler asks the question instead — see
`visibleCommands` in `src/queries.ts`.

**In an expression, an absent bind never widens the answer.** A predicate like
`[">=", "?rank", "?minRank"]` filters rows that already exist; it cannot scan
facts or create a variable. Omit the bind and the read usually fails outright:

```
query_failed: unbound input var ?rank; ?rank is read by an expression before any
earlier where, bind, or scalar clause binds it.
```

So a gate expressed this way FAILS CLOSED, which is why the command
authorization check is shaped that way — forgetting `?rank` cannot quietly
return every command. Guards built this way hold under rephrasing: comparing
directly, binding the comparison to a var and testing it, and wrapping it in
`not` were all measured, and all refuse the omitted bind.

**But the check is EVALUATION-time, not plan-time — it needs a row to reach the
predicate.** This is the part to be careful about, because the same reactor with
the same missing bind can error or not depending on the DATA:

- Zero candidate rows: silent empty result, no error.
- An `or` that short-circuits before reaching the var: no error. Measured on
  `visibleTo`'s exact shape (`published OR mine`) — with only published rows
  present, an omitted `?viewer` returned the published row happily; adding a
  single DRAFT row made the identical read start erroring.

**And a bind that matches NOTHING is fast, which is how a timing measurement
lies.** `[?sess sid ?sid]` with a `?sid` no session carries binds nothing, so every
clause after it joins against an empty set and the read returns `[]` immediately.
Measured against a seeded 10,000-todo database: the board with a real sid takes
about 180 seconds, and the same body with a made-up sid takes 17–93ms. That is not
a fast query, it is no query — and it is exactly the range phase 2 recorded as
evidence that "the app path is verified at 10,000". **When you time a bound read,
assert the ROW COUNT in the same breath.** A read that returns nothing costs
nothing, whatever it was supposed to be measuring.

The invariant that always held is the useful one: **an omitted expression-only
bind yields an error or a subset, never a superset.** So it is a real safety
property but not a reliable "this argument is required" — do not treat an
error-free read as proof the bind was supplied. `visibleTo` in `src/derive.ts`
sits exactly here today.

## Matching a VALUE is not indexed until you say so

The built-in read paths cover entities, transactions, fields and backlinks. None of
them covers "this field equals this value": the field path is ordered by entity and
transaction, so a clause like `["?c", "kind", "command"]` — or a `?sid` supplied as
a bind — scans every fact of that field and filters the payload. The lab's explain
says so per clause: `not component-indexed`, with an FET scan count next to it.

Value indexes are opt-in per field (`PUT`/`PATCH /indexes/{field}`, ETag-guarded);
only UTC, duration and UUID components promote automatically. Measured on the demo
data by toggling the whole set off and back on:

| board reactor | indexed | not indexed |
| --- | --- | --- |
| dry-run p50 | 27ms | 54ms |
| stored read p50 | 29ms | 54ms |

`src/indexes.ts` holds the list and `npm run stardust:setup` provisions it, so it
is policy in code rather than something done by hand to one database. The list is
the fields the reactors KEY on — matched as a constant, supplied as a bind, or used
as a join key. Fields only read out of an already-matched row (`title`, `order`,
`danger`) are deliberately absent: projection does not need a value index, and the
docs are explicit that each one costs write work and storage.

Worth knowing: reading a stored reactor with a bind costs about the same as the
equivalent dry-run. A stored reactor is not a cache you read for free.

## `limit` is a post-filter, and removing the subqueries did not change that

This was tested again in phase 3, because it looked like it should have changed.
Phase 1 measured `limit` as a post-filter while the board carried three correlated
`exists` clauses, and the obvious reading was that the subqueries were the reason —
a body with none of them ought to be able to stop after fifty rows. It cannot.
Measured on 2,000 unindexed todos, against the plain body, unfiltered:

| read | time |
| --- | --- |
| unlimited (1,941 rows) | 7.6s |
| `limit 50` | 7.5s |
| `limit 50 offset 1000` | 7.5s |
| `find[[count ?t]]` over the identical `where` | 7.5s |

Every number is the same read. The same four questions at 5,000 give 49.7s / 48.3s
/ 48.7s / 47.9s, and at 10,000 they give 253s / 239s / 243s / 237s — `limit` is
worth two to six percent, which is noise on a box that is doing anything else. (The
2,000 row is from a quiet box and the other two are not; compare across a row, never
down a column.)

The engine evaluates the whole `where` and then discards rows; only the projection
and the response get smaller. Three consequences worth carrying:

- Paging bounds the RESPONSE, the render, and the memory a result set occupies. It
  does not bound the query. Narrowing the FILTER is what bounds the query, and that
  is what the inlining change turned out to be about — see the tension entry. The
  counts/blockers/tags reads beside the board are still whole-workspace and not
  paged at all, so a page view is still O(workspace) even when the board is not.
- A count for a "showing 50 of N" pill costs a second full board. That is why the
  pill says `50+`: the board asks for `PAGE_SIZE + 1` rows and spends the extra one
  on "is there a next page", which is the only question the pager has.
- `limit` and `offset` are BODY fields and refuse a bind — `limit ?n`, `offset
  ?off` and `offset {#bind off}` are all `limit/offset must be number`. So a page is
  part of the query TEXT and one stored reactor cannot serve every page. That used
  to force a split: page 0 was a provisioned reactor and a deeper page an ephemeral
  one, created for the read and deleted after it (31–44ms to create, 21–38ms to
  delete, and a BLOCK of entity ids — consecutive board reactors came back 158
  apart, because every clause is an entity too, and deleting the reactor does not
  return them). The board's body varies with the filter now, so it is a dry-run and
  the split is gone: a window is two more numbers in a body that was being built
  anyway. Measured at 5,000 indexed, page 1 / 21 / 61 cost 418 / 489 / 434ms as a
  dry-run against 453 / 450 / 454ms through an ephemeral reactor — the same query
  plus the reactor's overhead, on every page but the first.

  The general form is still worth carrying, because the next stored reactor will
  hit it: a stored reactor fits a query whose BODY is fixed and whose inputs can
  all be binds. `limit`/`offset` cannot be binds, and neither can a clause that is
  present or absent. If either varies, it is a dry-run.

Also measured while establishing this: the plain board at 2,000 unindexed todos
allocates about 400MB of transient heap per read, and at 10,000 it peaks around
2.1GB and takes ~180s. Stardust is Go and treats allocation failure as fatal
(`runtime: out of memory` and the process is gone), so a stress instance that runs
out of room does not return an error — it dies mid-response and the client sees a
socket close. One was OOM-killed at 5.4GB RSS during exactly this. Give a big
stress instance room, and read `dmesg -T` before believing a stranger error.

One more failure that is not the server's: Node's `fetch` gives up on a response
BODY after five minutes and throws `TypeError: terminated` with a `BodyTimeoutError`
cause. The tag body at 10,000 todos crosses that line, and an unhandled throw there
cost a completed two-hour stress run its summary. Reads that can take minutes need
their own error arm.

## The tension is the point — record it, don't resolve it silently

Pushing everything into Stardust is not automatically right, and finding where it
stops being right is the interesting part. Real trades already made here, each
worth reading before you re-litigate one:

- A complex query body vs a simpler query plus app code. The board body computes
  effectiveStatus and every filter server-side. It is genuinely hard to read, and
  it is why the board needs no filtering layer at all.
- The facet filters: JOINED vs READ AND INLINED. REVERSED, by measurement, and this
  is the one to read before assuming "let the engine do it" means "make it a join".
  The filter is facts either way — that part never moved and is not up for
  discussion. The question was only whether the query MATCHES those facts or is
  BUILT from them. Matching them means the engine joins the session's `sf` children
  against every candidate row, and its cost therefore grows with the corpus times
  the number of values selected. Building the query from them means one literal
  comparison that NARROWS the candidate set. Measured at 5,005 todos, 50 rows,
  value indexes on: no facet filter at all is 51ms, the value-joins are 1,972ms,
  the inlined literals are 24ms. Unindexed the join is 32,775ms. Reproduced by the
  harness at 5,000 (`npm run stress`): 2,303ms → 56ms for one page under a narrow
  filter, 4,305ms → 403ms unfiltered.

  What it gives up, precisely. **One stored body no longer serves every filter
  combination.** There is no `board` reactor any more, in any shape; the body is a
  function of the selection (15 x 7 x 5 x 2 of them) so the rows are a dry-run built
  per read. Three consequences: the query is no longer a durable artifact you can
  read out of the database or hand to the lab with a bind, so what the x-ray offers
  is the `session-page` subscription instead; the app now OWNS the correctness of a
  compiler, where before it owned only a body; and every value that reaches that
  compiler has to be checked against a domain, because a value that becomes part of
  a query is not data any more. Tag labels have no domain — they are free text from
  `addTag` — so the tag filter is deliberately NOT inlined and stays the correlated
  `exists` it always was. What it gains beyond the speed: the body has no free vars
  left, so the "an omitted bind matches everything" hazard two sections up cannot
  apply to it, and a deep page stops costing an ephemeral reactor.
- The compile-time query checker only models plain 3-tuple fact clauses. Queries
  using `or` or a bound `exists` cannot use it, so they keep runtime validation and
  lose the compile-time check. That is why `define()` does not apply `CheckQuery`.
- Writing facets in ONE transaction stopped subscribers seeing half-written filter
  states, but a transact bypasses the schema, so those values are checked app-side
  against the generated validators instead.
- `kind` is redundant for ten of eleven entity families — the field shape already
  identifies them. It stays because the redundancy is cheap insurance against a
  future entity carrying the same fields.
- The command role gate moved INTO the query, the denial copy did not. `[">=",
  "?rank", "?minRank"]` belongs there because it is the rule; "Owner only" does
  not, because changing a string should not be a reactor patch, and English in a
  stored query cannot be localised. The line drawn was rule-in, copy-out.
- That gate cost lines rather than saving them: the two command reactors are
  longer than the `project()` they replaced. It was taken for the fail-closed
  bind and for one definition serving menu and write boundary, NOT for brevity —
  the same trade as promoting the per-render queries. Expect it again.
- Derive-on-read vs materialise, for `blocked`: REVERSED, and this is the entry
  that contradicts the advice at the top of this file. A correlated `exists` is
  executed once per candidate row, and Stardust caps TOTAL subquery executions at
  10,000 per query as ONE SHARED BUDGET — so the board does not degrade past a few
  thousand todos, it hard-fails, and it already costs 15.7s unindexed at 2,000. The
  same question asked without correlation ("which todos have a not-done blocker")
  is one scan, ~10ms for a whole workspace. So the derivation moved to the write
  path: `blocked`, `effectiveStatus` and `prank` are stored fields, and the rule is
  that the transaction which causes a change records the consequence — the dep edge
  and the flag land in ONE transact, a status write patches its dependents with the
  causing tx as their causation id. This is not a cache; facts are the log, so
  recording a consequence is what the log is for.

  What it gives up, precisely: the invariant moved from "guaranteed by the query"
  to "guaranteed by write discipline plus a reconciliation check". Every path that
  can change the answer must go through `refreshDerived` — that is why the write
  paths are funnelled through `patchTodo` and why `addDependency`/`removeDependency`
  /`removeTodo` are the only other doors. `reconcileBlocked()` asks the plain query
  and reports every row that disagrees; it is ~10ms, so run it in tests and after
  an import. A writeback reactor cannot take this job: verified in both directions,
  `then.patch` does not fire on a dep edge being added OR retracted, only on a write
  to the blocker's own `status`, so a todo left `blocked:true` stays wrong forever.
- The role HIERARCHY is still TypeScript (`roleRank`: any < member < owner). The
  app turns a role into a rank and Stardust compares it, so half of "who may do
  what" is still a deploy away. Making ranks facts is the obvious next step and
  was deliberately not bundled in.

When you make one of these calls, say which way you went and why in the commit
message. A reversed decision is fine; an unrecorded one gets made again.

## Checks

`npm run check` — format, lint, typecheck, knip, tests. knip earns its keep: it
catches the cascade when removing one unused thing exposes the next. It cannot see
dynamic `import()` though, so confirm before deleting a file it calls unused.

Reactors and schemas are provisioned by name, idempotently:
`npm run stardust:setup`. Re-running is free.
