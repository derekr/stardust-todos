// Generate the query field-map + runtime validators from the LIVE Stardust
// schemas. This is the hybrid's foundation: ONE generated artifact drives both
// the compile-time query checker (the field→type map) and the runtime boundary
// validation (per-field predicates) — so neither can drift from the engine.
//
//   STARDUST_URL=http://localhost:1990 node scripts/gen-query.ts   (npm run gen:query)

import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STARDUST_URL ?? "http://localhost:1990";
const INSTANT_FIELDS = new Set(["due", "at", "endsAt", "startsAt"]);

// JSON Schema property → a TypeScript type expression.
function tsType(name: string, p: any): string {
  if (p.enum) return p.enum.map((e: unknown) => JSON.stringify(e)).join(" | ");
  if (p.type === "string") return "string";
  if (p.type === "boolean") return "boolean";
  if (p.type === "number" || p.type === "integer") return "number";
  if (p.type === "object") return INSTANT_FIELDS.has(name) ? "Instant" : "Ref";
  return "unknown";
}

// JSON Schema property → a runtime predicate `(v: unknown) => boolean`.
function validator(name: string, p: any): string {
  if (p.enum) return `(v) => (${JSON.stringify(p.enum)} as unknown[]).includes(v)`;
  if (p.type === "string") {
    return p.minLength ? `(v) => typeof v === "string" && v.length >= ${p.minLength}` : `(v) => typeof v === "string"`;
  }
  if (p.type === "boolean") return `(v) => typeof v === "boolean"`;
  if (p.type === "number" || p.type === "integer") return `(v) => typeof v === "number"`;
  if (p.type === "object") {
    return INSTANT_FIELDS.has(name)
      ? `(v) => typeof (v as any)?.["#utc"] === "string"`
      : `(v) => typeof (v as any)?.["#"] === "number"`;
  }
  return `() => true`;
}

async function main() {
  const list = (await (await fetch(`${BASE}/schemas`, { headers: { Accept: "application/json" } })).json()) as {
    schemas?: string[];
  };
  let out =
    `// GENERATED from Stardust schemas — do not edit by hand.\n` +
    `// Regenerate:  npm run gen:query   (with Stardust running)\n\n` +
    `export type Ref = { "#": number };\n` +
    `export type Instant = { "#utc": string };\n\n`;

  for (const u of list.schemas ?? []) {
    const schema = await (await fetch(`${BASE}${u}`, { headers: { Accept: "application/schema+json" } })).json();
    if (!schema?.title) continue;
    const title = String(schema.title).replace(/\W/g, "");
    const props = Object.entries<any>(schema.properties ?? {}).sort(([a], [b]) => a.localeCompare(b));

    // The field→type map (every field is queryable — optionality doesn't apply here).
    out += `export interface ${title}Fields {\n`;
    for (const [name, p] of props) out += `  ${name}: ${tsType(name, p)};\n`;
    out += `}\n\n`;

    // Per-field runtime validators, keyed to the same fields.
    out += `export const ${title.toLowerCase()}Validators = {\n`;
    for (const [name, p] of props) out += `  ${name}: ${validator(name, p)},\n`;
    out += `} satisfies Record<keyof ${title}Fields, (v: unknown) => boolean>;\n\n`;
  }

  await mkdir("src/generated", { recursive: true });
  await writeFile("src/generated/query-fields.ts", out);
  console.log("wrote src/generated/query-fields.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
