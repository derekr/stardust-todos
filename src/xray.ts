// X-ray mode — an inline "how is this resolved?" overlay. When enabled, every
// data-driven region (anything tagged `data-xray="<key>"`) is outlined; clicking
// one pops a card explaining the Stardust query/derivation behind it, with a real
// code sample and a source pointer. It's the glass box, in situ.
//
// Cards backed by a stored reactor also offer "copy as RON": the body is fetched
// from the DATABASE on click, not re-serialized from the literal in queries.ts, so
// what lands on the clipboard is what is actually running — ready to paste into
// the Stardust console's /reactors/lab.
//
// Zero app-state: it's a self-contained overlay (a registry embedded as JSON + a
// small vanilla script) that both the list and detail pages include verbatim.

import { B } from "./base.ts";

interface XraySpec {
  title: string;
  mech: string; // one-paragraph explanation
  code: string; // a real, concise snippet
  src: string; // file · function pointer
  /**
   * The stored reactors behind this card, offered as "copy as RON".
   *
   * The `code` above is a readable ILLUSTRATION — trimmed, commented, sometimes
   * TypeScript. This is the real thing: the body is fetched from the database on
   * click, so it cannot drift from what is running.
   *
   * `bind` is an example, not a default. Every one of these leaves vars for the
   * reader to supply, and Stardust does not object to a missing bind on a fact
   * clause — it just answers for every value. Pasting a body into the lab without
   * one is how you get a confidently wrong answer.
   */
  reactors?: { name: string; bind: string }[];
}

const XRAY: Record<string, XraySpec> = {
  board: {
    title: "The board — the filter is the URL, compiled into the query",
    mech: "Your filter is the QUERY STRING you are looking at — `?st=todo&v=ready&p=2` — and every read compiles it into the body as LITERAL FACT CLAUSES, at the FRONT: `[?t effectiveStatus blocked]`. Where they sit is half of what they are worth. Stardust evaluates a `where` in the order it is written and does not reorder it, so the leading clause is what the read STARTS from and everything after it filters that. These used to be expressions at the end, over vars the rest of the body had already bound — which means walking the whole workspace in `prank` order and discarding rows, fine for a dense selection and terrible for a sparse one. 124 of 9,947 todos here are blocked, so `?st=blocked` filled its 51-row window in 193ms where the unfiltered board took 52ms; written first, the identical body costs 27ms and returns the same 51 rows in the same order. Every filter this board has got faster and none got slower, dense ones included: `?st=blocked&pr=high` 262→29ms, `?v=mine` 49→24ms, `?tag=design` 47→24ms, `?st=todo` — 69% of the corpus — 52→33ms. It used to be facts on a per-browser `session` entity, joined into the body by matching `sf` children against every candidate row. Two things moved, in that order. First the join became an inline, which is worth 41x: measured on 5,000 todos with value indexes on, one page of fifty, the value-join costs 2,303ms and the inlined form 56ms — faster than no filter at all, because a literal NARROWS the candidate set while a join adds work proportional to it. Then the facts themselves went, because by that point nothing was EVALUATING them: they were being read back and compiled in, which is what a query string does for free. They were not free — ~129 facts per session and ~46 per filter click on an append-only store, and this demo held 24,389 facts for twelve todos — and they were not buying reactivity either, since the live subscription has no `sf` clause and a filter write re-emitted nothing at all. What the URL buys on top: back and forward work, the link is shareable, and two people opening it get two independent views rather than one shared mutable session they overwrite each other in. What it costs: the filter is INPUT now, so every value is checked against its domain before it can become query — `archived` is refused, and a TAG (free text, no fixed domain) is checked against the labels this workspace actually uses. The TAG chips are the newest part of this and the one that was actually broken: the filter used to be a correlated `exists` over the tag EDGE entities, and a subquery's output is capped at 1,000 rows per directive — so one label took 82.7s, and three labels put 1,275 edges through that directive, were REFUSED, and the app rendered the refusal as an empty board. A todo carries its labels as a fact of its own now (`tags ['design' 'launch']`, written by the same transaction as the edge), so the filter is two ordinary clauses: bind the list, test membership. 84ms at ten thousand todos, flat in the number of labels, and each todo comes back once however many of the selected labels it carries — which is the duplicate that made it a subquery in the first place. The ORDER is a function of the filter too, for a reason that is not obvious: what an `orderBy` costs is its LEADING key's cardinality, not how many keys it has. `[?title ?prank]` is 6ms on this board and `[?prank ?title]` is 47ms — two keys either way, both value-indexed, same rows — because a key with three distinct values cannot drive an index-ordered scan and the whole visible set gets sorted instead. So when you pin a single priority every row has the same `prank`, ordering by it is provably a no-op, and dropping it lets `?title` lead: `?pr=med` 184ms → 6ms, in exactly the same order, because within one priority \"prank then title\" IS \"title\". The rest of the body is unchanged: it derives nothing per row (blocked/effectiveStatus/prank are stored facts the write paths recorded, JOINED here) and returns ONE PAGE — `limit 51`, fifty shown and a fifty-first read only to know whether a next page exists, which is why the pill says \"50+\". `limit` is a POST-FILTER, measured at 2,000 unindexed todos as 7.6s unlimited and 7.5s with `limit 50`, and a bare count over the same `where` costs the same — so paging bounds the response and the render, not the query. Narrowing the filter is what bounds the query. The tag CHIPS themselves stopped being a query at the same time, and for the opposite reason to the tally beside them: the vocabulary of a workspace changes when a label is used for the first time or removed for the last, which is almost never, so it is a fact on the workspace entity that the tag writes maintain — `tagVocab ['api' 'bug' …]`, read in 5.5ms where the `groupBy` over 4,246 tag edges cost 29.5ms of every render to answer the same ten rows. Interning the label as an ENTITY was measured too and lost at 8.1ms, because listing ten entities is only cheaper than one fact if the label has something to carry. Materialise what changes rarely, subscribe to what changes often. Liveness is a different reactor: `page-rows` subscribes to the fifty rows on screen. Paging past the end costs nothing now either — the tally in memory is an upper bound on every filtered subset of the board, so `?p=200` returns an empty page without a read, where it used to scan to an offset with nothing behind it for 285.9ms and 303ms. You do not have to take any of these numbers on trust: add `?debug=1` to this URL and the server appends what THIS request cost — every read, with the number of rows it returned beside it — or open /inspect, where the last sixty requests are listed with the same breakdown. The row count is the part that matters, because a filter that matched nothing is fast and looks exactly like a filter that was quick.",
    code: `// Built per read, from the URL. What the FILTER narrows to comes
// FIRST: the engine does not reorder a where, so the leading clause
// is what the read starts from. 193ms -> 27ms for ?st=blocked.
{
  find: ["?t"],
  where: [
    ["?t", "effectiveStatus", "blocked"],  // ?st=blocked — was 4 clauses
    ["?t", "priority", "high"],            // ?pr=high    — was 4 clauses
    // several selected values cannot be a literal, so they bind a var
    // of their own and test membership over it — 25ms for two:
    //   ["?t","effectiveStatus","?effIn"],
    //   ["contains", {"#set": ["todo","doing"]}, "?effIn"]
    // …and NOTHING at all for a facet with everything selected: a
    // clause that cannot remove a row is not written.  85ms -> 54ms
    ["?t", "effectiveStatus", "todo"],     // ?v=ready, chosen at compile time

    // ?tag=design,launch — the todo's OWN labels, bound once per row,
    // then a membership test. This was a correlated exists over the
    // tag EDGES, which REFUSED at three labels (subquery output is
    // capped at 1,000 rows per directive) — 104,475ms -> 84ms:
    ["?t", "tags", "?tags"],
    ["any", ["fn", ["l"],
             ["contains", {"#set": ["design", "launch"]}, "l"]], "?tags"],

    // …and only then the clauses that are true of every todo, where
    // the order among them cannot matter because none of them narrows:
    ["?t", "app", "todo-app"],
    ["?t", "workspace", {"#": 12}],   // scope: the server's, never yours
    ["?t", "status", "?status"], ["?t", "priority", "?priority"], /* … */
    ["?t", "blocked", "?blocked"],    // the derived facts, JOINED —
    ["?t", "effectiveStatus", "?eff"],//   recorded by the write that
    ["?t", "prank", "?prank"],        //   caused them
    ["or", ["=", "?draft", false], ["=", "?author", {"#": 7}]],

    // ?v=overdue's comparison trails on purpose: the clauses above are
    // what make ?t a TODO, and a 'due' read off a SCHEMA entity (which
    // declares the property) is a ref that < refuses — at evaluation
    // time, so it would 400 on page 4 and work on page 1.
  ],
  orderBy: ["?prank", "?title"],  // high→med→low, then title. ONE key when
                                  // the filter pins a priority: prank is
                                  // constant then, and a 3-value key cannot
                                  // lead an index scan.  184ms -> 6ms
  limit: 51, offset: 100,                // ?p=2 — 50 shown, 1 read-ahead
  then: { project: { id: "?t", effectiveStatus: "?eff",
                     blocked: "?blocked", /* … */ } },
}
// what the two facet filters replaced, per facet — matched against
// every candidate row, four clauses at a time:
//   ["?fs","kind","sf"], ["?fs","session","?sess"],
//   ["?fs","facet","status"], ["?fs","value","?eff"]

// a value is checked against its domain BEFORE it becomes query:
//   status 'archived' is not one of todo, doing, blocked, done  → 400
// tag labels have no fixed domain, so the check is the workspace's
// own tag vocabulary — the same list these chips are drawn from.

// the label is stored twice, by ONE transaction: the tag EDGE and
// the todo's own list, which is what the filter above matches.
await transact({
  "#_e": { kind: "tag", todo: {"#": todoId}, label: "design" },
  [todoId]: { tags: ["design", "launch"] },
});
await reconcileTags()   // [] means the two still agree

// …and a THIRD time, on the workspace: which labels exist here at
// all. That was a groupBy over 4,246 edges on every render — 29.5ms
// for the same ten rows — and it is one fact now, read in 5.5ms:
{ find: ["?vocab"], where: [[workspaceId, "tagVocab", "?vocab"]] }
await reconcileTagVocabulary()      // the guard for that one

// read it:  await readSnapshot(boardQuery(scope, filter), page)`,
    src: "src/filter.ts · decodeFilter() · src/board-query.ts · canonicalBody() + readSnapshot() · src/tags.ts · tagClauses() + tagVocabulary() + reconcileTagVocabulary()",
    reactors: [{ name: "page-rows", bind: "{ps {# 1519}}" }],
  },
  counts: {
    title: "Counts — a viewer-scoped tally, subscribed rather than read",
    mech: "These numbers are NOT read when this page renders. `board-counts` is a stored reactor and the server holds ONE subscription per (workspace, viewer) actually in use; the latest emission sits in memory, a paint takes it out of a field, and Stardust pushes a new one when the underlying data moves. The HTML you are reading was served with them already in it: the server-rendered pass peeks at that same memory without subscribing or holding anything, which is what keeps a page turn from painting `50 · …` and filling it in afterwards. The placeholder is left only for a scope genuinely nobody is watching — the subscription behind an open board lingers 30s at zero holders precisely because a navigation closes one stream before opening the next, and this document is served in that gap. The chips are the one thing on this page a reader cannot change — they are deliberately not narrowed by the active facets, which is exactly what makes them mean \"how many you would get if you picked this\" — so a page turn cannot move them and neither can a filter change. Only a write can, and a write is what the engine is already watching for. It runs over the viewer-VISIBLE set, the same visibility rule as the board, so a draft you can't see cannot leak into the numbers; that is why the key is (workspace, viewer) and not workspace alone. It is grouped in the ENGINE by (effectiveStatus, priority) — eleven rows out of 9,947 — and the app folds those into the two tallies the chips want, because the chips want every value present including the zeroes. This body has been a stored reactor, then a dry-run with its scope INLINED, and now a stored reactor again, and the measurement did not change: at 10,003 todos it is 197ms read through the reactor with `?ws`/`?viewer` as binds and 132ms as a dry-run with both spelled as literals, because a value the planner has when it plans is one it can narrow on. What changed is that a bind is a price PER READ and a subscription pays it once — the 65ms buys a body that can be subscribed at all, and every push after it is free. So the tally went from ~240ms on every paint to 0ms on every paint but the first for a scope — 246-273ms measured on this demo for that first subscribe, against 75-96ms for the whole rest of the page, which is why a cold scope waits for the push rather than counting synchronously in front of the reader. The invalidation was verified rather than assumed, from a second process, with two subscriptions on this one reactor bound to two personas: a status write moved the tally, a new todo appeared in it, completing a blocker moved the `blocked` group and the target group in ONE emission, a title-only write pushed nothing at all, and a draft authored by one persona woke that persona's subscription and NOT the other's. It also bought something nobody asked for: the emission patches the chips itself, so a write to a todo that is not on the page you are reading moves these numbers now, where before only a repaint could.",
    code: `// stored again, and subscribed — not read per render:
export const boardCounts = define("board-counts", {
  find: ["?eff", "?priority", ["count", "?t"]],
  where: [
    ["?t", "app", "todo-app"],
    ["?t", "workspace", "?ws"],           // a bind: ~28ms, ONCE
    ["?t", "effectiveStatus", "?eff"],    // stored, not derived
    ["?t", "priority", "?priority"],
    ["?t", "draft", "?draft"], ["?t", "author", "?author"],
    ["or", ["=", "?draft", false],
           ["=", "?author", "?viewer"]],  // a bind: ~51ms, ONCE
  ],
  groupBy: ["?eff", "?priority"],         // 11 rows, not 9,947
});

// one subscription per (workspace, viewer) in use, refcounted by the
// board streams looking at it — the render just reads the field:
boardCounts.watch({ ws: {"#": 12}, viewer: {"#": 7} },
                  (rows) => { sub.now = tally(rows); }, signal);

// and the SSR pass, which holds nothing, reads the same field —
// so the numbers are IN the document rather than patched in after it:
const counts = peekCounts(wsId, viewerId);   // no query, no hold

// -> [["todo","med",3858], ["doing","high",430], …]  on connect,
//    and again on every write that moves one of those clauses.
// A title write moves none of them and pushes nothing.`,
    src: "src/counts.ts · holdCounts() + peekCounts() · src/queries.ts · boardCounts · src/derive.ts · visibleTo()",
    reactors: [{ name: "board-counts", bind: "{ws {# 12} viewer {# 7}}" }],
  },
  blocked: {
    title: "Blocked — recorded by the write that causes it",
    mech: 'Blocked-ness used to be derived on every read: a CORRELATED exists over the dep graph, bound to a variable so cond/or/and could filter on it — `[["exists", depSub], "?blocked"]`. It does not scale, because Stardust executes a correlated subquery ONCE PER ROW against a budget of 10,000 executions shared by the entire query: the board failed outright past a few thousand todos and cost 15.7s unindexed at 2,000, and `limit` cannot help because it is a post-filter. The uncorrelated form of the same question — one scan for every todo with a not-done blocker — is about 10ms for a whole workspace. So `blocked` is a STORED fact now, and the flag you are looking at was JOINED, not computed: the board reads `[?t blocked ?blocked]`. The rule for keeping it true is that the transaction which causes a change records the consequence — a status write patches its dependents, adding a dep edge writes the flag in the SAME transaction as the edge. That is not a cache. Facts are the log, so writing the consequence is recording it, at the moment it happened and with a causation id naming the write that caused it. What it costs is the guarantee: correctness used to be a property of the query, and is now a property of every write path going through one choke point — so there is a reconciliation check that asks the plain query and reports any row that disagrees.',
    code: `// the plain question, once for the whole workspace (~10ms):
find: ["?t"],
where: [["?d", "kind", "dep"], ["?d", "todo", "?t"],
        ["?d", "blocker", "?b"], ["?b", "status", "?bs"],
        ["!=", "?bs", "done"]],

// adding an edge: cause and consequence in ONE transaction
await transact({
  "#_e": { kind: "dep", todo: {"#": todoId}, blocker: {"#": blockerId} },
  [todoId]: { blocked: true, effectiveStatus: "blocked" },
});

// a status write moves its DEPENDENTS, so they are refreshed with it:
await refreshDerived(await dependentsOf(id), causingTx);

// the guard for what this gives up — stored vs the plain query:
await reconcileBlocked()   // [] means every write path kept its promise

// and the board just reads it back:
["?t", "blocked", "?blocked"], ["?t", "effectiveStatus", "?eff"]`,
    src: "src/todos.ts · refreshDerived() + reconcileBlocked() · src/board-query.ts · canonicalBody() (which now joins them)",
    reactors: [{ name: "page-rows", bind: "{ps {# 1519}}" }],
  },
  visibility: {
    title: "Draft visibility — an app predicate, server-side",
    mech: "Stardust does authentication, not authorization — so row-level visibility is an APP predicate: a todo is visible if it's published OR you authored it. ONE definition of that rule (visibleTo) serves every read. On the board the viewer is an INLINED literal, taken from the server's own \"view as\" state; on the counts and options reactors it is a per-read BIND \u2014 and on the counts one that bind is the whole point, because a bind is what a subscription is scoped by and a literal cannot be. Either way the rule is an expression-`or`, and the browser never sends a persona id at all: the URL carries what to NARROW to, never what scope to read in, so no query string can widen it. It stays join-free, paginates, and keeps hidden rows off the wire.",
    code: `// One rule. A "?var" leaves the viewer to a per-read bind (reactors);
// a persona id pins it into the query (one-shot dry-runs).
function visibleTo(viewer) {
  const who = typeof viewer === "number" ? { "#": viewer } : viewer;
  return [
    ["?t", "draft", "?draft"],
    ["?t", "author", "?author"],
    ["or", ["=", "?draft", false], ["=", "?author", who]],
  ];
}

// the board body — the viewer is a literal the server supplies:
...visibleTo(viewPersona)   // ["or", ["=","?draft",false],
                            //        ["=","?author",{"#":7}]]

// board-counts / todo-options — supplied per read, and per
// SUBSCRIPTION: two subscriptions on one reactor bound to two
// personas were woken separately, and a draft one of them
// authored did not wake the other at all.
await boardCounts.watch({ ws: {"#": wsId}, viewer: {"#": personaId} },
                        onRows, signal);`,
    src: "src/board-query.ts · canonicalBody() · src/derive.ts · visibleTo() (bound as ?viewer in src/queries.ts)",
  },
  "detail-meta": {
    title: "Metadata — assembled from facts",
    mech: "detailData() composes the detail from facts and small queries: readEntity for the todo, tagsOf for tags, a `?todo`-bound reactor for blockers, and a reverse-dependency query for the 'Blocks' row (which todos depend on this one). No joins baked into a table — each field is a fact or a scoped query.",
    code: `// "Blocks" = the todos that depend on THIS one (reverse edge),
// declared once and read with the todo bound per call:
export const blockedByTodo = define("todo-blocks", {
  find: ["?t", "?bt"],
  where: [
    ["?d", "kind", "dep"],
    ["?d", "blocker", "?todo"],       // this todo is the blocker
    ["?d", "todo", "?t"],
    ["?t", "title", "?bt"],
  ],
  then: { project: { id: "?t", title: "?bt" } },
});

await blockedByTodo.read({ todo: {"#": id} });
// the detail page takes the titles; the write path takes the ids —
// they are the rows whose stored 'blocked' a status write here moves.`,
    src: "src/server.ts · detailData()",
    reactors: [{ name: "todo-blocks", bind: "{todo {# 729}}" }],
  },
  blockers: {
    title: "Blocked by — a dependency-graph join",
    mech: 'blockersFor() runs one join over kind:\'dep\' edges (todo → blocker) and buckets by todo id — for the ids ON THIS PAGE, not for the workspace. It used to be a stored reactor over every edge in the workspace, read on every board render to decorate fifty rows: 34ms at 10,003 todos against 9ms for the two rows on an unfiltered first page that actually draw a ⊘, and no read at all when none of them do. The membership test is where the sharp edge is: `?t` is bound through the `todo` REF field, so a set of BARE ids matches nothing — 7ms, zero rows, and a board that looks right with every badge missing. The set holds refs. Dependencies are real edge ENTITIES, not an inline array on the todo — so adding/removing one is a single fact write, and the graph is directly queryable. The PICKER below it is where reading the graph gets interesting at scale. It used to offer every visible todo — 9,947 buttons, a 686KB read, 307ms of a 361ms page — so it was bounded to the first 25 by title, which made the page 83ms and made a blocker further down the alphabet unpickable. Typing in it now asks a different index: `title` carries an analyzed english TEXT index as well as a value one, and [fts <term> ?t ?score] returns entity ids with BM25 scores that join back to ordinary clauses. What bounds it is the TERM, not the limit: at 10,003 todos a term matching four rows costs 3ms, one matching 625 costs 11ms and one matching 2,498 costs 42ms. Ordered by [[?score desc] ?t] with a limit IS the bounded top-k the docs describe — 4ms against 17ms unlimited for that 2,498-row term — but only while the fts clause is the whole query; join the workspace and visibility clauses back on and it costs the same limited as unlimited, so `limit` is the post-filter it is everywhere else here. It is a stemmer and not a prefix matcher, so "land" finds "① Design landing page" (both stem to `land`) and "landi" finds nothing. Two things it is deliberately not: not a stored reactor, because the term would have to travel as a RON bind and this app\'s bind writer does not escape quotes (a search for o\'brien becomes `unknown bind var ?brien`) — and not exempt from visibility, because the same visibleTo fragment is in the body, so a draft you cannot see is not a candidate you can search up.',
    code: `// the rows on screen that draw a badge, and no others:
{
  find: ["?t", "?b", "?bt", "?bs"],
  where: [
    ["?d", "kind", "dep"],
    ["?d", "todo", "?t"],
    // REFS, not bare ids — ?t is bound through a ref field, and
    // {"#set": [738, 742]} matches nothing, fast and silently:
    ["contains", {"#set": [{"#": 738}, {"#": 742}]}, "?t"],
    ["?d", "blocker", "?b"],
    ["?b", "title", "?bt"], ["?b", "status", "?bs"],
  ],
  then: { project: { todo: "?t", blocker: "?b",
                     title: "?bt", status: "?bs" } },
}

// the picker's typeahead — the term is a VALUE in the body,
// never text spliced into a query, and the read is a dry-run:
{
  find: ["?t", "?title", "?score"],
  where: [
    ["fts", term, "?t", "?score"],   // analyzed title terms
    ["?t", "app", APP],
    ["?t", "workspace", {"#": wsId}],
    ["?t", "title", "?title"],
    ...visibleTo(viewerId),          // drafts stay invisible
  ],
  orderBy: [["?score", "desc"], "?t"],  // bounded top-k
  limit: 20,
  then: { project: { id: "?t", title: "?title" } },
}`,
    src: "src/board.ts · blockersFor() · searchTodoOptions()",
  },
  commands: {
    title: "Commands — the role gate AND the state rule are the query",
    mech: 'Every command in this menu is a Stardust ENTITY (kind:"command") carrying its label, the role rank it needs, whether a denied viewer sees it grayed, its scope, and the states it APPLIES TO. Two things decide what you get, and both are clauses. The viewer\'s rank is a BIND: [">=", "?rank", "?minRank"] decides enabled, ["or", "?enabled", "?showWhenDenied"] decides visible, and rows that fail never leave the database. The subject\'s state is a bind too: the command\'s `appliesTo` is a LIST and ["any", ["fn", ["s"], ["=", "s", "?state"]], "?applies"] keeps only the commands that mean something on a thing in that state — which is why a DONE todo offers "Reopen todo" where an open one offers "Mark complete", with no `if` anywhere in the renderer. The two rules are different in kind and the query treats them differently: a denied command can still be advertised greyed with a reason, an inapplicable one is simply not a member of this menu. The app does no filtering and holds no visibility flag — this menu reads {scope \'todo\' rank N state \'done\'} and the ⌘K palette reads {scope \'global\' rank N state \'global\'}, same definition. The write boundary (POST /command/<id>) asks a second reactor for that one cmdId at that rank in that state, reading the target\'s status fresh: an EMPTY result is the refusal, so POSTing todo.complete at a todo that was completed a second ago is REFUSED rather than merely hidden, and the verdict is never re-derived in TypeScript. Granting Teammate the right to archive, or letting an action apply to one more state, stays a fact write rather than a deploy. Forgetting either bind cannot silently open the gate — ?rank and ?state are both read by expressions, and an expression cannot invent a variable, so the read fails with \'unbound input var ?rank\' rather than matching every row. That is the opposite of a fact-clause var like ?scope, where an absent bind quietly returns everything.',
    code: `// the menu: Stardust decides what you may SEE, here
const commandMenu = define("command-menu", {
  find: ["?cmdId", "?label", "?minRank",
         "?enabled", "?danger", "?order"],
  where: [
    ["?c", "kind", "command"],
    ["?c", "scope", "?scope"],            // supplied per read
    ["?c", "appliesTo", "?applies"],      // e.g. ['todo' 'doing']
    ["any", ["fn", ["s"],                 // …does this state
             ["=", "s", "?state"]],       //    make it meaningful?
     "?applies"],
    ["?c", "minRank", "?minRank"],
    ["?c", "showWhenDenied", "?showWhenDenied"],
    [[">=", "?rank", "?minRank"], "?enabled"],
    [["or", "?enabled", "?showWhenDenied"], "?visible"],
    ["=", "?visible", true],              // invisible rows never return
    /* … cmdId, label, danger, order … */
  ],
  orderBy: ["?order"],
});

// the write boundary: no rows IS the refusal
const commandAuthz = define("command-authz", {
  where: [["?c", "cmdId", "?cmdId"],
          ["?c", "appliesTo", "?applies"],
          ["any", ["fn", ["s"], ["=", "s", "?state"]], "?applies"],
          ["?c", "minRank", "?minRank"],
          [">=", "?rank", "?minRank"], /* … */],
});

// this menu, asked about THIS todo
await visibleCommands({ scope: "todo", status }, role)
// same two rules, on the write
await authorizeCommand(cmdId, { scope: "todo", status }, role)`,
    src: "src/queries.ts · commandMenu + commandAuthz · src/commands.ts · CATALOG + visibleCommands() + authorizeCommand()",
    reactors: [
      { name: "command-menu", bind: "{scope 'global' rank 2 state 'global'}" },
      { name: "command-authz", bind: "{cmdId 'workspace.archive' rank 2 state 'global'}" },
    ],
  },
  activity: {
    title: "Activity — read straight off the fact log",
    mech: "No audit table, and no event replay needed. Every fact carries the transaction that asserted it, so ONE facts read for this entity + field already IS that field's history — a `status` fact only exists because that write actually changed the value. Rows come back newest-first; we reverse to chronological, then attribute the whole set from its TRANSACTION entities, where the commit instant and the Tx-Meta headers landed as ordinary facts. That attribution used to be one HTTP round trip PER ROW, which is what made this 44ms for 17 rows on a pane that shows eight — eighteen requests to render eight lines. It is two requests now, 11ms, and the two things that had to be got right are both worth knowing. A transaction is an ordinary entity, so `[?tx stardust/committed ?at]` matches it and one dry-run can carry the page's worth; but the membership test has to be an `or` of `[= ?tx {# N}]`, because `[contains {#set …} ?tx]` against a var bound in SUBJECT position matches NOTHING — fast, zero rows, and every timestamp silently blank. And `or` is a macro with a size limit (twelve branches read, fourteen are `macro expansion size exceeded`), so the ids are chunked. `actor` and `causationId` are OPTIONAL on a transaction and a `where` clause is an existence filter, so they are read as dotted projection PATHS, which return the key absent instead of dropping the row — safe in a dry-run, and never in a stored reactor, where a path is invisible to invalidation. (The /inspect page does use bus replay — that's a different mechanism, for the whole log.)",
    code: `// One read, bounded to what the pane SHOWS — newest-first.
const rows = await readFacts({ entityId: id, field: "status", limit: 8 });
//   [{ component: "doing", tx: { "#": 3460 }, entity: { "#": 216 } }, …]

// Attribution for the whole page in ONE dry-run, not one read per row:
{
  find: ["?tx"],
  where: [
    ["?tx", "stardust/committed", "?at"],       // a tx is an ordinary entity
    ["or", ["=", "?tx", {"#": 3460}], ["=", "?tx", {"#": 3456}], /* … */],
  ],                    // NOT [contains {#set […]} ?tx] — that matches NOTHING
  then: { project: { root: "?tx", fields: {
    tx: "?tx", at: "?at",
    actor: ".actor",        // OPTIONAL on a tx, so read by PATH: a where
    cause: ".causationId",  // clause would drop every unattributed write
  } } },
}
// 44ms/17 rows and 18 round trips  ->  11ms/8 rows and 2.`,
    src: "src/history.ts · statusHistory()",
  },
  concurrency: {
    title: "The CTA — a guarded transition",
    mech: "This button is a state-machine TRANSITION, so it carries the entity's last transaction (its version) as ?expect. The server makes the write conditional with Tx-Check-Last — a compare-and-swap on that version. If someone moved the todo since you looked, Stardust refuses with 409 and the write is NOT applied; the server patches a toast and the live stream re-paints the truth. The segmented Todo/In Progress/Done control is a deliberate manual override, so it stays unguarded. The version is the same transaction id the Activity timeline shows — no extra bookkeeping.",
    code: `// CTA embeds the entity's last tx at render time (lastTx = newest fact):
@post('/todo/216/status/doing?expect=3456')

// The write is made conditional on it (CAS on the entity version):
patchSchemaEntity(schemaId, id, { status }, { actor }, {
  checkLast: { [id]: expectTx },      // Tx-Check-Last-Type: json
});                                   // Tx-Check-Last: {"216":3456}

// Stardust refuses with 409 and commits NOTHING. The record stream's
// terminal item names the conflict and both versions:
//   {"stardust/error":true, "code":"transaction_conflict",
//    "message":"entity 216 last tx check failed: expected 3456, got 3460",
//    "details":{"entity":"216","expectedTx":3456,"actualTx":3460}}

// The server turns the refusal into a toast + refresh — never a clobber:
if (e instanceof TxConflictError)
  stream.patchSignals({ toast: "Someone changed this task — refreshed to the latest." });`,
    src: "src/stardust.ts · lastTx() + Tx-Check-Last",
  },
};

const SCRIPT = `
(function(){
  var XR = JSON.parse(document.getElementById('xray-data').textContent);
  var pop = document.getElementById('xray-pop');
  var tgl = document.getElementById('xray-toggle');
  var on = false;
  function setOn(v){ on = v; document.body.classList.toggle('xray-on', on); tgl.classList.toggle('on', on); if(!on) pop.hidden = true; }
  tgl.addEventListener('click', function(){ setOn(!on); });
  document.addEventListener('keydown', function(e){
    if(e.altKey && e.key.toLowerCase()==='x'){ e.preventDefault(); setOn(!on); }
    else if(e.key==='Escape'){ pop.hidden = true; }
  });
  document.addEventListener('click', function(e){
    if(!on) return;
    if(e.target===tgl || e.target.closest('#xray-pop')) return;
    var el = e.target.closest('[data-xray]');
    if(el){ e.preventDefault(); e.stopPropagation(); showPop(el.getAttribute('data-xray'), el); }
    else { pop.hidden = true; }
  }, true);
  function copyRon(r, btn, pre, runnable){
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'fetching\u2026';
    var q = '';
    if(runnable){
      // scope the copy to whatever this page is showing
      var b = document.getElementById('board');
      var ps = b && b.getAttribute('data-pgset');
      var t = location.pathname.match(/\\/todo\\/(\\d+)/);
      q = '?runnable=1' + (ps ? '&ps=' + ps : '') + (t ? '&todo=' + t[1] : '');
    }
    fetch(XRAY_BASE + '/xray/ron/' + encodeURIComponent(r.name) + q)
      .then(function(res){ if(!res.ok) throw new Error(res.status); return res.text(); })
      .then(function(txt){
        // show the real body either way: if the clipboard is unavailable
        // (it needs a secure context) it can still be selected by hand.
        pre.textContent = txt;
        if(!navigator.clipboard) throw new Error('no clipboard');
        return navigator.clipboard.writeText(txt);
      })
      .then(function(){ btn.textContent = runnable ? '\u2713 copied \u2014 runs as-is' : '\u2713 copied \u2014 free vars, see below'; })
      .catch(function(){ btn.textContent = 'shown above \u2014 select and copy'; })
      .then(function(){
        btn.disabled = false;
        setTimeout(function(){ btn.textContent = label; }, 4000);
      });
  }
  function row(cls, txt){ var d=document.createElement('div'); d.className=cls; d.textContent=txt; return d; }
  function showPop(key, el){
    var d = XR[key]; if(!d) return;
    pop.innerHTML='';
    var h=document.createElement('div'); h.className='xr-head';
    var t=document.createElement('span'); t.className='xr-title'; t.textContent=d.title; h.appendChild(t);
    var x=document.createElement('button'); x.className='xr-x'; x.textContent='\\u00d7'; x.addEventListener('click',function(){pop.hidden=true;}); h.appendChild(x);
    pop.appendChild(h);
    pop.appendChild(row('xr-mech', d.mech));
    var pre=document.createElement('pre'); pre.className='xr-code'; pre.textContent=d.code; pop.appendChild(pre);
    (d.reactors||[]).forEach(function(r){
      var exact=document.createElement('button');
      exact.className='xr-ron'; exact.type='button';
      exact.textContent='\u29c9 ' + r.name + ' as stored';
      exact.addEventListener('click', function(){ copyRon(r, exact, pre, false); });
      pop.appendChild(exact);
      var run=document.createElement('button');
      run.className='xr-ron xr-run'; run.type='button';
      run.textContent='\u25b6 runnable in lab';
      run.addEventListener('click', function(){ copyRon(r, run, pre, true); });
      pop.appendChild(run);
      pop.appendChild(row('xr-bind',
        'free vars: ' + r.bind + ' \u2014 pasted bare they match EVERYTHING (the page ' +
        'reactor returns the rows of every open board at once). "runnable" prepends ' +
        'a bind {\u2026} clause for this page, which the lab lets you edit.'));
    });
    pop.appendChild(row('xr-src', d.src));
    var r=el.getBoundingClientRect();
    pop.hidden=false;
    var pr=pop.getBoundingClientRect();
    var top=r.bottom+8, left=Math.min(r.left, window.innerWidth-pr.width-12);
    if(top+pr.height > window.innerHeight-12) top = Math.max(12, r.top-pr.height-8);
    pop.style.top = Math.max(12, top)+'px';
    pop.style.left = Math.max(12, left)+'px';
  }
})();
`;

/** Everything x-ray needs, dropped in verbatim before </body> on any page. */
export function xrayAssets(): string {
  const data = JSON.stringify(XRAY).replace(/</g, "\\u003c");
  return `
  <button id="xray-toggle" aria-label="toggle x-ray mode" title="X-ray the data mechanics (⌥X)">⚡ x-ray</button>
  <div id="xray-pop" hidden></div>
  <script type="application/json" id="xray-data">${data}</script>
  <style>
    #xray-toggle{position:fixed;right:14px;bottom:calc(80px + env(safe-area-inset-bottom));z-index:80;
      font-family:var(--mono);font-size:12px;color:var(--muted);background:var(--elev2);
      border:1px solid var(--line);border-radius:999px;padding:7px 13px;cursor:pointer;
      display:flex;gap:5px;align-items:center;box-shadow:0 6px 18px rgba(0,0,0,.4);}
    #xray-toggle.on{color:#1d2021;background:var(--aqua);border-color:var(--aqua);font-weight:600;}
    @media (min-width:900px){ #xray-toggle{bottom:16px;} }
    body.xray-on [data-xray]{outline:1px dashed var(--aqua);outline-offset:3px;border-radius:4px;cursor:help;}
    body.xray-on [data-xray]:hover{background:rgba(142,192,124,.10);}
    #xray-pop{position:fixed;z-index:81;width:min(92vw,430px);max-height:72vh;overflow:auto;
      background:var(--elev);border:1px solid var(--aqua);border-radius:14px;padding:14px;
      box-shadow:0 22px 60px rgba(0,0,0,.6);}
    #xray-pop[hidden]{display:none;}
    .xr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;}
    .xr-title{font-size:14px;font-weight:700;color:var(--aqua);line-height:1.3;}
    .xr-x{border:0;background:transparent;color:var(--muted);font-size:18px;line-height:1;cursor:pointer;padding:0 2px;}
    .xr-mech{font-size:13px;line-height:1.55;color:var(--fg);margin-bottom:10px;}
    .xr-code{font-family:var(--mono);font-size:11.5px;line-height:1.5;color:var(--fg);background:var(--bg);
      border:1px solid var(--line);border-radius:9px;padding:11px;overflow-x:auto;white-space:pre;margin:0 0 8px;}
    .xr-src{font-family:var(--mono);font-size:11px;color:var(--faint);}
    .xr-ron{font-family:var(--mono);font-size:11px;color:var(--aqua);background:transparent;
      border:1px solid var(--aqua);border-radius:7px;padding:5px 9px;cursor:pointer;margin:0 6px 6px 0;}
    .xr-ron:disabled{opacity:.6;cursor:default;}
    .xr-run{color:var(--bg);background:var(--aqua);font-weight:600;}
    .xr-bind{font-family:var(--mono);font-size:10.5px;color:var(--faint);margin:0 0 8px;}
  </style>
  <script>var XRAY_BASE=${JSON.stringify(B)};${SCRIPT}</script>`;
}
