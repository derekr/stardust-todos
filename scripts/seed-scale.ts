// Grow the DEMO workspace to N todos, so the UI can be looked at under load.
//
//   STARDUST_URL=http://127.0.0.1:3010 node scripts/seed-scale.ts --n 10000
//
// This is not the stress harness. `scripts/stress/` writes an adversarial corpus
// into a throwaway database and asserts things about it; this writes a plausible
// backlog into the workspace the live demo actually opens, and the only thing it
// asserts is that the demo still looks like the demo. It reuses `bulk()` from the
// harness's seeder, because the one thing that genuinely matters — batch size — was
// measured there: 100 entities per transact ran at 7k facts/s and 5,000 at 70k.
//
// Two decisions worth knowing about.
//
// **Titles are prefixed with `▪`.** The board orders by `[?prank ?title ?t]`, so the
// first page is the fifty lowest titles among the high-priority todos. Stardust
// orders text by CODEPOINT (verified: `0 digit`, `Buy`, `Zebra`, `apple`, `zzz`,
// `~tilde`, `Æon`, `① Design`, `▪ block`, `〜wave`), and every original demo title is
// ASCII or `①`–`④`, all of which sort before `▪` (U+25AA). So the eight demo todos
// stay first WITHIN their priority band, and the default view still opens on the
// landing-page chain rather than on row 1 of ten thousand. Being exact about what
// that does and does not give: page one is the high-priority band, so the five
// high-priority demo todos lead it and the three others (`Reply to Ada's email`,
// `③ QA landing page`, `Read the Stardust docs`) lead the med and low bands, one
// priority chip away. Nothing short of giving the demo rows a rank of their own puts
// all eight on page one, and inventing a rank for them would be lying to the sort.
//
// **The derived facts are written WITH the row.** `blocked`, `effectiveStatus` and
// `prank` are stored, and a reader that matches on a field a row has never been
// written skips the row in silence — so a todo missing `prank` does not sort oddly,
// it disappears. The generator knows which dep edges it is about to write, so it
// knows the consequence before the cause, which is the same position the app's own
// write paths are in.

import { bulk, tx } from "./stress/seed.ts";
import { defaultWorkspace } from "../src/workspace.ts";
import { ensureUser, listPersonas } from "../src/tenancy.ts";
import { BASE, query } from "../src/stardust.ts";

const argv = process.argv.slice(2);
const arg = (name: string, dflt: number) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : Number(argv[i + 1]);
};
const TARGET = arg("--n", 10_000);
const BATCH = arg("--batch", 2_000);

// A plausible backlog rather than a uniform one. Real boards are mostly medium and
// mostly open, which also makes the filter chips interesting: every one of them
// narrows to a different order of magnitude.
const PRIORITY = ["high", "med", "low"] as const;
const PRANK = { high: 0, med: 1, low: 2 } as const;
const TAGS = ["launch", "learning", "design", "infra", "docs", "bug", "chore", "ux", "api", "mobile"];
const VERB = [
  "Rewrite",
  "Audit",
  "Ship",
  "Triage",
  "Document",
  "Benchmark",
  "Migrate",
  "Deprecate",
  "Instrument",
  "Backfill",
  "Reconcile",
  "Harden",
  "Simplify",
  "Cache",
  "Retry",
];
const NOUN = [
  "the ingest pipeline",
  "the billing webhook",
  "the search index",
  "the onboarding flow",
  "the retry budget",
  "the audit log",
  "the seat allocator",
  "the export job",
  "the schema registry",
  "the rate limiter",
  "the session cache",
  "the diff viewer",
  "the changelog",
  "the health check",
  "the token refresh",
  "the media uploader",
];
const QUAL = ["", " for EU tenants", " before the audit", " (phase 2)", " on mobile", " under load", " for the API"];

const DAY = 86_400_000;

/** Todo `k`, as a pure function of `k` — same corpus every run, no state. */
function shape(k: number) {
  const p = k % 20 < 3 ? "high" : k % 20 < 14 ? "med" : "low";
  const done = k % 7 === 0;
  const doing = !done && k % 5 === 1;
  const status = done ? "done" : doing ? "doing" : "todo";
  // every 60th todo is blocked by its predecessor — and only counts as blocked if
  // that predecessor is not itself done
  const blockedBy = k % 60 === 11 && k > 0 ? k - 1 : null;
  const blocked = blockedBy !== null && blockedBy % 7 !== 0;
  const tags: string[] = [];
  if (k % 3 === 0) tags.push(TAGS[k % TAGS.length]!);
  if (k % 11 === 0) tags.push(TAGS[(k * 7 + 3) % TAGS.length]!);
  return {
    priority: p as (typeof PRIORITY)[number],
    status,
    done,
    blockedBy,
    blocked,
    // "blocked" is an EFFECTIVE status only; `status` itself is user intent and
    // never holds it. `done` wins over blocked.
    effectiveStatus: done ? "done" : blocked ? "blocked" : status,
    draft: k % 97 === 0,
    byOwner: k % 194 !== 0, // half the drafts belong to the teammate
    lastActor: k % 4 === 0 ? "Owner" : "Teammate",
    // a fifth carry a due date; two thirds of those are already past, so `overdue`
    // has something to show and `mine`/`ready` are not the only interesting views
    due: k % 5 === 2 ? Date.now() + (k % 3 === 0 ? 30 * DAY : -((k % 90) + 1) * DAY) : null,
    title: `▪ ${VERB[k % VERB.length]} ${NOUN[(k * 3) % NOUN.length]}${QUAL[(k * 5) % QUAL.length]} #${k}`,
    tags,
  };
}

async function main() {
  console.log(`stardust ${BASE}\n`);
  const ctx = await defaultWorkspace();
  const user = await ensureUser("default@local");
  const personas = await listPersonas(user);
  const owner = ctx.personaId;
  const member = personas.find((p) => p.name === "Teammate")?.id ?? owner;

  const existing = (
    (await query({
      find: [["count", "?t"]],
      where: [
        ["?t", "app", "todo-app"],
        ["?t", "workspace", { "#": ctx.workspaceId }],
      ],
    })) as [number][]
  )[0]![0]!;
  console.log(`  workspace #${ctx.workspaceId} holds ${existing.toLocaleString()} todos`);
  const want = TARGET - existing;
  if (want <= 0) {
    console.log(`  already at or past ${TARGET.toLocaleString()} — nothing to write.`);
    return;
  }

  const t0 = Date.now();
  const ids = await bulk(
    BASE,
    want,
    (k) => {
      const s = shape(k);
      const t: Record<string, unknown> = {
        kind: "todo",
        app: "todo-app",
        workspace: { "#": ctx.workspaceId },
        title: s.title,
        status: s.status,
        priority: s.priority,
        done: s.done,
        draft: s.draft,
        author: { "#": s.byOwner ? owner : member },
        lastActor: s.lastActor,
        blocked: s.blocked,
        effectiveStatus: s.effectiveStatus,
        prank: PRANK[s.priority],
      };
      if (s.due !== null) t.due = { "#utc": new Date(s.due).toISOString() };
      return t;
    },
    BATCH,
    (done) => {
      const secs = (Date.now() - t0) / 1000;
      console.log(
        `  todos ${done.toLocaleString()}/${want.toLocaleString()}  ${Math.round(done / secs).toLocaleString()}/s`,
      );
    },
  );

  // Edges second: they reference todos, so every id has to exist first.
  const edges: Record<string, unknown> = {};
  let e = 0;
  for (let k = 0; k < want; k++) {
    const s = shape(k);
    for (const label of s.tags) edges[`#_e${e++}`] = { kind: "tag", todo: { "#": ids[k] }, label };
    if (s.blockedBy !== null) {
      edges[`#_e${e++}`] = { kind: "dep", todo: { "#": ids[k] }, blocker: { "#": ids[s.blockedBy] } };
    }
  }
  const keys = Object.keys(edges);
  for (let off = 0; off < keys.length; off += BATCH) {
    const slice: Record<string, unknown> = {};
    for (const key of keys.slice(off, off + BATCH)) slice[key] = edges[key];
    await tx(BASE, slice);
  }
  console.log(`  edges ${keys.length.toLocaleString()} (tags + deps)`);
  console.log(`\nseeded ${want.toLocaleString()} todos in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log("run `npm run stardust:setup` so the value indexes cover them.");
}

main().catch((e) => {
  console.error(`\n\x1b[31mseed failed:\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
