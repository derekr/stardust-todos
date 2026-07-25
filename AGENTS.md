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
`command` fact set pushed to an open `command-catalog` subscription immediately,
with nothing watching the commit bus.

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

The counterpart trap is the same asymmetry in the other direction: Stardust
rejects a bind var name it does not know, but never an ABSENT one — an unbound var
matches everything and the over-broad result looks healthy. See `commandsInScope`
in `src/queries.ts` for the shape of the guard.

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

When you make one of these calls, say which way you went and why in the commit
message. A reversed decision is fine; an unrecorded one gets made again.

## Checks

`npm run check` — format, lint, typecheck, knip, tests. knip earns its keep: it
catches the cascade when removing one unused thing exposes the next. It cannot see
dynamic `import()` though, so confirm before deleting a file it calls unused.

Reactors and schemas are provisioned by name, idempotently:
`npm run stardust:setup`. Re-running is free.
