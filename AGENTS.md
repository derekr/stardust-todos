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
- All server-side filter state. FULLY REVERSED, in two steps, and it is the
  cautionary entry on this list rather than a success — read the tension section
  before you push the next piece of per-user state into the database. Filters were
  facts on a per-browser session entity, first JOINED into the board body and then
  READ AND INLINED (worth 82x). The inlining is what ended it: once the app was
  reading the facts back and compiling them into the query, the engine was not
  EVALUATING them for anything, and a value the app reads back and compiles in is a
  parameter wearing a fact's clothes. It is a query string now.
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

That paragraph has since been TAKEN UP for tags, and the change is the clearest
demonstration of it in the repo. A todo now carries its labels as a fact of its own
(`tags ['design' 'launch']`, tags.ts) as well as as edges, because the board could
not filter on the edges at all — and the side effect is exactly what the rule
predicts. The detail pane subscribes to `GET /entities/{id}`, which is the todo's
OWN facts; a tag edge is a different entity, so adding one used to be invisible
there, and adding one now re-emits that subscription. Measured against the live
demo with a subscription held open from a second shell: one snapshot on connect, a
second the moment `addTag` committed, a third on `removeTag`, with nothing watching
the bus. (The snapshot names the list by REF — `tags {# 27272}` — because an array
component is stored as a nested list entity; only a find TUPLE resolves it to
`['design' 'launch']`. See tags.ts.) The board's rows are still a dry-run and still
push nothing — that is a separate decision, four paragraphs down — but the FACT is
in a place a subscription can see it now, which it was not before.

**And a query that is not a reactor pushes nothing at all, which is a liveness
decision and not only a performance one.** The board's rows are a dry-run, so
NOTHING about the filtered set is live; the app's only board subscription is
`page-rows`, which watches the fifty rows on screen. That is deliberate — a
subscription over the whole filtered set pushes membership churn at you while you
are reading — but it means anything that changes WHICH rows belong is not going to
arrive by itself.

That used to be a hazard and is now a non-question, and the difference is worth
carrying because it is the clearest thing the filter change bought. When the filter
was a fact, changing it wrote to the database, that write pushed nothing (the
subscription has no `sf` clause and never did), and the app compensated by aborting
its own SSE stream and re-opening it — `remount()` plus a `boardGate` to stop the
re-subscribe racing the write. Forgetting that was silent: the board kept showing
the previous answer, which shipped once and no test caught it, because every test
opens a fresh stream. The filter is in the URL now, so changing it is a NAVIGATION:
a different document, a different stream, and the old one closed by the browser.
There is nothing left to remember to re-open. The general shape: if a piece of
state selects WHICH rows a subscription is about, either put it in a top-level
clause of that subscription or put it somewhere that re-opening is automatic. The
middle option — a fact nothing watches — is the one that costs you a bug.

**`bind.with.facts` works on a LIVE subscription, and is still the wrong tool for
liveness.** It overlays facts for one evaluation — replacements, retractions, new
entities, temp ids — and a subscription accepts it, which makes "what would the
board look like if this todo were done" a real, cheap question to ask. But it
invalidates at CLAUSE-FIELD granularity with no result-equality suppression: any
write to a field named by any clause re-emits, whether or not the answer changed.
That is fine for a preview a user is holding open for a second, and wrong for a
standing subscription, which is why nothing here uses it. (Reported and recorded,
not re-measured in this pass — treat the granularity claim as the thing to check
first if you build on it.)

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

## Searching a value is a THIRD index, and it is the one that backfills

A value index answers "which rows have this exact title". Nothing here ever asked
that, and for the blocker picker it is the wrong question: every meaningful word
in this corpus is in the MIDDLE of a title, so a range read over the value index
(`[>= ?title 'Buy'] [< ?title 'Buz']`, a real 84ms read that correctly finds `Buy
coffee beans`) can never find `① Design landing page` from "landing". Text search
is a separate policy on the same `/indexes/{field}` document, and `title` now
carries both.

**PATCH one section, never PUT.** `PUT` replaces BOTH desired sections, so a PUT
carrying only `fullText` resets `valueIndex` to `default` — which would cost the
board its index-ordered scan (36ms against 252ms at ten thousand) with no error
anywhere. `PATCH fullText {analyzers [english]}` preserves the value index;
verified on a copy of the demo, where `valueIndex{enabled true source explicit}`
came back untouched. Both are ETag-guarded, and 412 means someone else moved
first.

**There was no desired/active gap to observe.** The docs describe `desired` being
set while `active` catches up and `catchUp.state` reads `building`, and
`ensureTextIndex` tests the ACTIVE section for exactly that reason — but at 10,003
titles the backfill happens INSIDE the PATCH: it returned after 3.6s with
`active{fullText{analyzers[english]}}` and `textSearch{state ready lag 0}` already
true. (Re-enabling after a disable took 2.1s; disabling took 425ms.) So provisioning
is synchronous at this size, and `npm run stardust:setup` finishing is what makes
search work. Expect the documented asynchronous states on a corpus large enough to
need them, and expect `dormant` — which is healthy — on a field with no text yet.

**The state that DOES appear is lag behind live writes, and it did not bite.**
Under a burst of title writes `/healthz` showed the Full-text index `lagging` with
a lag of 9, and search fails closed while it is behind (`fts index not ready:
sequence <fts>, canonical <eftc>`). Sixty races — a title write and a search issued
in the same breath, forty at the engine and twenty through the app — produced zero
errors and zero short answers, because retry-capable execution waits for catch-up
and retries in a fresh snapshot. Do not build on that being free; do note that the
app needs no retry arm of its own for it.

**What it costs.** 49,880 postings over 10,036 documents for 10,003 titles; the
database file 32.2 MiB → 48.4 MiB; a single-field title write p50 2.7ms with the
analyzer on against 1.8ms with it off, measured by toggling it over the same
corpus. So it is affordable exactly once, on one field, which is why `TEXT_FIELDS`
has one entry and the board — which filters on values it already has an index for
— does not use it.

**It is a stemmer, not a prefix matcher, and that shapes the UI.** The same
pipeline runs over the stored text and the query text, so "land" finds "landing"
(both stem to `land`) and "landi" finds NOTHING on the way there. A stop-word-only
query ("the") returns zero rows rather than erroring. That is a real limitation of
a typeahead built this way and the picker says so in its empty state rather than
looking broken.

**`limit` is still a post-filter the moment a real query surrounds the search.**
The docs give `orderBy [[?score desc] ?entity]` + `limit` as the bounded top-k
shape and it genuinely is one — for a term matching 2,498 rows, bare, `limit 20`
costs 4ms against 17ms unlimited. Join `title` on and it is 12ms; join the app,
workspace and visibility clauses the picker actually needs and it is 42ms, which
is what that body costs with no `limit` at all. Same lesson as the board, reached
from a different direction: what bounds an fts read is the TERM (3ms for four
matches, 11ms for 625, 42ms for 2,498, against a corpus of 10,003), not the cap.

**A search term cannot travel as a bind, and this is the sharp edge.** Stardust
accepts `[fts ?q ?entity ?score]` and an omitted `?q` FAILS CLOSED — `query: fts
input ?q is unbound` — which is a third entry for the section above: fts input is
neither a fact clause that widens nor an expression that needs a row to reach it,
it simply refuses. The problem is on this side. `ronBind` in stardust.ts is the one
place this app builds RON by hand, and it wraps a string bind in single quotes with
no escaping, so binding `q` to `o'brien` produces `{q 'o'brien'}` and the read
comes back `unknown bind var ?brien`. No caller binds free text today (the string
binds in use are `scope`, a two-value domain), so it is latent rather than live —
but it is why the picker's search is a dry-run with the term as a VALUE in a JSON
body. Fix `ronBind` before the next feature wants a string bind from a user.

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

  **There is a second pagination mode this app has never tried, and it is the
  counter to the paragraph above.** 0.0.6 documents KEYSET pagination: a request
  carries `page.size` (`pageSize`/`pageAfter` on stored result routes) and the
  response is one nested item, `result [...] page {hasMore true next OPAQUE_TOKEN}`.
  It answers the "one stored reactor cannot serve every page" problem directly,
  because the cursor is a parameter of the REQUEST rather than of the body — so a
  stored reactor could serve page 40. The CHANGELOG claims a page after 5,000 rows
  going from 19.50ms to 531.5µs, 36.7x, which if it holds is the only thing measured
  here that would make a deep page cheaper rather than merely no more expensive.
  What the docs say it costs, and why it has not simply been adopted: it CANNOT be
  combined with `limit` or `offset`, it needs an ordered eligible query, and the
  token is opaque, expiring, and bound to the query, authorization, database, page
  size, ordering AND snapshot — "start from the first page after changing any
  input". A prev/next pager over a shareable URL wants a cursor that survives being
  bookmarked, and this one is explicitly not that. Untested here. If deep paging
  ever becomes the bottleneck, this is the experiment, and the honest shape is
  probably keyset for a scrolling reader plus offsets for a link.

One more directive with a hard ceiling rather than a slope, found the same way:
`not` is a SUBQUERY, correlated like any other, and its output is capped at 1,000
rows PER DIRECTIVE. `["not", ["?t", "workspace", "?w"]]` over an app's todos is
fine at 900 and fails outright at 1,001 with `where subquery row/output limit
exceeded (per directive max 1000)`. Three boot-time backfills asked exactly that
question, so the web server refused to start against any database with more than a
thousand todos in it — including every stress corpus, none of whose rows were
missing anything. They take the set difference app-side now (`todosMissing` in
todos.ts): every app todo with a title, minus the ones carrying the field, 28ms and
43ms at 10,003 rows. The rule that keeps generalising is that a subquery's cost and
its ceiling are both per-ROW, so anything correlated has a corpus size at which it
stops working rather than slowing down.

**That output cap is a DIFFERENT ceiling from the 10,000-execution budget, and it
is the one that shipped a bug.** The budget counts subquery EXECUTIONS across a
whole query and is what retired `blocked`; this one counts ROWS out of ONE
directive, and it does not care how many rows reached the clause. The board's tag
filter — a correlated `exists` over the tag edges, the app's last subquery — died
of it in production, on the public demo, measured through the app:

| `?tag=` | status | time | rows |
| --- | --- | --- | --- |
| `design` | 200 | 82.7s | 50 |
| `design,launch` | 200 | 77.7s | 50 |
| `design,launch,api` | 200 | 60.4s | **0** |

The third is not a timeout: at ~425 edges per label, three labels put 1,275 rows
through one directive, the engine refused the query, and the app rendered the
refusal as an empty board. So the ceiling moves with the TAG VOCABULARY's density,
not with the corpus — a third of the size of the todo count would not have saved
it, and neither would `limit`. Two lessons worth separating: a subquery has two
independent ceilings, and a filter that comes back EMPTY and fast is the failure
mode to look for first, because it looks exactly like a correct answer. Tags are a
component on the todo now (tags.ts) and the board runs no subquery at all: 84ms for
one label at ten thousand todos, and flat in the number of labels.

**`or` is not a disjunction of PATTERNS, and getting that wrong is silent.** The
obvious way to filter on several labels once each todo carries them as fields is
`["or", ["?t", "tag/design", true], ["?t", "tag/launch", true]]`. Stardust accepts
it and it matches EVERYTHING: 9,948 rows of 9,948, the same as no clause at all,
and the same for a single-branch `or`. A fact pattern inside an expression is a
three-element list, a list is truthy, so the clause is a constant `true`. Stardust
has no or-join; `or` is an expression over values that are already BOUND (which is
what `visibleTo` uses it for), and the engine's own answer for "is this row's value
one of these" is `[contains {#set [...]} ?v]` — see the pokemon tutorial, which says
so outright. This is the same shape as the omitted-bind hazard above: not an error,
not a subset, a SUPERSET. Assert a row count against a query you have just
rewritten, every time.

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
- The facet filters: JOINED vs READ AND INLINED, and then FACTS vs A QUERY STRING.
  Reversed twice, both times by measurement. Read this before assuming that "let
  the engine do it" means "make it a join" — or that state being facts is
  self-evidently the right answer.

  The FIRST reversal was about how the filter reaches the query: whether the query
  MATCHES the session's facts or is BUILT from them. Matching them means the engine
  joins the session's `sf` children against every candidate row, so its cost grows
  with the corpus times the number of values selected. Building the query from them means one literal
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
  is the `page-rows` subscription instead; the app now OWNS the correctness of a
  compiler, where before it owned only a body; and every value that reaches that
  compiler has to be checked against a domain, because a value that becomes part of
  a query is not data any more. What it gains beyond the speed: the body has no free
  vars left, so the "an omitted bind matches everything" hazard two sections up
  cannot apply to it, and a deep page stops costing an ephemeral reactor.

  The SECOND reversal followed from the first, and took a while to see precisely
  because the first had been such a clear win. Once the app reads the facts back and
  compiles them into the body, nothing in the engine is EVALUATING them. The filter
  was not being stored for anything; it was a parameter spelled as facts. Three
  things were then measured, and all three said to stop:

  * **The facts bought no reactivity.** The one thing a fact buys that a parameter
    cannot is a subscriber waking up. `session-page` had no `sf` clause and no
    `page` clause, so a filter write re-emitted nothing at all, and the repaint came
    from `remount()` aborting the SSE stream and re-opening it. Reactivity-for-free
    had already died when the page-set landed; nobody had noticed, because the
    workaround was working.
  * **They cost writes that never stop costing.** ~129 facts per session and ~46
    per filter click, on an append-only store where retraction appends more facts.
    The demo held twelve todos in 24,389 facts across 7,274 entities and 84
    sessions. Worse, that churn taxes UNRELATED writes permanently: a three-fact
    todo patch measured 4ms at 7.5k facts, 9ms at 192k and 17ms at 369k, reproduced
    by growing the database with entities the patch never touches. The cheapest
    interaction on the page was making every future write slower.
  * **A mutable session is the wrong thing to share.** `/s/<sid>` handed a second
    reader the SAME session, so two people on one link shared one filter and
    overwrote each other. A URL-encoded filter gives each recipient an independent
    view — which is what sharing a filtered board means everywhere else.

  The property the facts were supposed to protect survives verbatim: "the server
  holds no per-user FILTER state" is exactly as true of a query string. The stronger
  claim was never true — `liveSessions`, `boardStreams`, `boardGate` and
  `viewPersona` were all per-process state sitting right beside it.

  What the URL costs, precisely. The filter is INPUT now, arriving from a client
  rather than from a schema-checked write, so the domain check stops being belt to
  the schema's braces and becomes the only check there is. `decodeFilter` REFUSES an
  unknown status, priority, view, group or page rather than dropping it — dropping
  widens the board, which is the failure nobody notices. And tag labels, which have
  no fixed domain and were therefore the one filter deliberately kept out of the
  body, no longer have a session to correlate to: they are inlined like everything
  else, checked against `availableTags` — the workspace's actual tag vocabulary,
  which is a real domain and which the render already reads — and checked again by
  `tagLabel` on the way into the body.
- Tags: EDGE ENTITIES vs a COMPONENT on the todo — BOTH, and this entry used to end
  by calling the tag clause "the slowest thing on the page". That was wrong twice
  over. It was not slow, it was BROKEN (82.7s for one label, a REFUSAL for three,
  rendered as an empty board — see the output-cap entry above), and a correlated
  `exists` was never going to be the fix. A todo now carries its labels as a `tags`
  list component as well, written by the same transaction as the edge, and the board
  matches the component: `[?t tags ?tags]` plus `[any [fn [l] [contains {#set […]}
  l]] ?tags]`. One page went 104,475ms to 84ms at ten thousand todos, flat in the
  number of labels, returning exactly the rows the `exists` returned where the
  `exists` could still run (420 for one label, 841 for two, identical and in order).

  Why BOTH, and not one. The EDGE stays because it is the vocabulary
  `availableTags` groups over and what the detail page reads, and because it keeps a
  label a piece of data. The COMPONENT is what a filter can use: matching the edge is
  a join that returns a todo carrying two selected labels TWICE, and de-duplicating
  that is a subquery, which is where the ceiling came from. A LIST rather than a
  field per label (`tag/design true`) for the reason in the `or` entry above — one
  field per label is right for one label and cannot express two, and the version
  that looks like it can silently matches everything.

  What it gives up is what `blocked` gave up: an invariant that used to be the
  query's is now write discipline plus a check. `addTag`/`removeTag` write both
  halves in one transaction, `reconcileTags()` reports every todo where the two
  disagree, `migrateTagComponents()` writes what it reports (and runs at boot), and
  the harness drives the sequence a denormalised set gets wrong — add, add again, add
  a second, remove one, remove the last, and delete a tagged todo, whose edges
  OUTLIVE it, which is why the guard requires the todo to still have a title.
  Also gone with the sessions: the `Session` and `SessionFacet` schemas, and the
  generated `facet`/`value` validators that existed only because the atomic facet
  write bypassed the schema route it was declared for.
- The compile-time query checker only models plain 3-tuple fact clauses. Queries
  using `or` or a bound `exists` cannot use it, so they keep runtime validation and
  lose the compile-time check. That is why `define()` does not apply `CheckQuery`.
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
- Full-text search vs a prefix range, for the blocker picker: FULL TEXT, and the
  deciding measurement was not speed. The range read works today with no setup
  (84ms, right answer) and the analyzer costs a 3.6s backfill, 16MiB and ~1ms per
  title write — but a prefix cannot match a word in the middle of a title, which is
  every word in this data. Speed was a wash; reach was not. The search is a DRY-RUN
  rather than a stored reactor for a reason that is a bug report as much as a
  design call: the term cannot safely be a bind while `ronBind` builds RON by hand.
  See the search section above.
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
