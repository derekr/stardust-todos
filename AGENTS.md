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
  have two filters and the server holds none.
- A revision counter used to force re-emits. Writing the facts re-emits.
- Per-render dry-runs, promoted to stored reactors read with a per-call bind, so
  one reactor serves every workspace, viewer and todo.

Derived state especially: prefer computing on read (a correlated `exists` bound to
a variable) over materialising a field and then having to un-write it.

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
what makes one stored reactor per shape, rather than one per caller, sound.

**The gap is what only enters through a bound `exists`.** Adding a TAG to a todo
pushes nothing to the board reactor — verified from a background script, and again
with the tag filter active, so even an edge that changes which rows match is
invisible. Adding a DEP does push (measured twice). Both reach the board only
through a bound `exists`, so "subqueries don't invalidate" is the wrong lesson.
The rule that has never missed is the first one: reason about what appears as a
top-level clause. If liveness matters for a fact, put it there.

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

## The tension is the point — record it, don't resolve it silently

Pushing everything into Stardust is not automatically right, and finding where it
stops being right is the interesting part. Real trades already made here, each
worth reading before you re-litigate one:

- A complex reactor body vs a simpler query plus app code. The board reactor
  computes effectiveStatus and every filter server-side. It is genuinely hard to
  read, and it is why the board needs no filtering layer at all.
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
