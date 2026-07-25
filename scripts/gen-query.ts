// Generate a FIELD REGISTRY from the LIVE Stardust schemas.
//
// Stardust has no entity types ("schemas are boundaries, not classes") — a
// query matches fact patterns over FIELDS, so the observable vocabulary is a
// field→type map, not a set of entity shapes. We merge every schema's
// properties into one registry (a field appearing in >1 schema unions its
// types). Fields written open-world (no schema) are DECLARED separately in
// src/field-registry.ts and merged there.
//
//   STARDUST_URL=http://localhost:1990 node scripts/gen-query.ts   (npm run gen:query)

import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STARDUST_URL ?? "http://localhost:1990";
const INSTANT_FIELDS = new Set(["due", "at", "endsAt", "startsAt"]);

function tsType(name: string, p: any): string {
  if (p.enum) return p.enum.map((e: unknown) => JSON.stringify(e)).join(" | ");
  if (p.type === "string") return "string";
  if (p.type === "boolean") return "boolean";
  if (p.type === "number" || p.type === "integer") return "number";
  if (p.type === "object") return INSTANT_FIELDS.has(name) ? "Instant" : "Ref";
  return "unknown";
}
function validator(name: string, p: any): string {
  if (p.enum) return `(v) => (${JSON.stringify(p.enum)} as unknown[]).includes(v)`;
  if (p.type === "string")
    return p.minLength ? `(v) => typeof v === "string" && v.length >= ${p.minLength}` : `(v) => typeof v === "string"`;
  if (p.type === "boolean") return `(v) => typeof v === "boolean"`;
  if (p.type === "number" || p.type === "integer") return `(v) => typeof v === "number"`;
  if (p.type === "object")
    return INSTANT_FIELDS.has(name)
      ? `(v) => typeof (v as any)?.["#utc"] === "string"`
      : `(v) => typeof (v as any)?.["#"] === "number"`;
  return `() => true`;
}

async function main() {
  const list = (await (await fetch(`${BASE}/schemas`, { headers: { Accept: "application/x-ndjson" } })).json()) as {
    schemas?: string[];
  };

  // Merge fields across ALL schemas. field -> { types:Set, validators:Set, sources:Set }
  const reg = new Map<string, { types: Set<string>; vals: Set<string>; from: Set<string> }>();
  for (const u of list.schemas ?? []) {
    // `application/schema+json` is for SENDING a schema; reading one back needs a
    // negotiated record profile, or 0.0.6 answers 406 with an empty body.
    const schema = await (await fetch(`${BASE}${u}`, { headers: { Accept: "application/x-ndjson" } })).json();
    const title = String(schema.title ?? u);
    for (const [name, p] of Object.entries<any>(schema.properties ?? {})) {
      const e = reg.get(name) ?? { types: new Set(), vals: new Set(), from: new Set() };
      e.types.add(tsType(name, p));
      e.vals.add(validator(name, p));
      e.from.add(title);
      reg.set(name, e);
    }
  }

  const names = [...reg.keys()].sort();
  let out =
    `// GENERATED from Stardust schemas — do not edit by hand.  npm run gen:query\n` +
    `// A FIELD registry (Stardust has no entity types — schemas are boundaries).\n\n` +
    `export type Ref = { "#": number };\n` +
    `export type Instant = { "#utc": string };\n\n` +
    `export interface SchemaFieldTypes {\n`;
  for (const n of names)
    out += `  ${n}: ${[...reg.get(n)!.types].join(" | ")};  // from ${[...reg.get(n)!.from].join(", ")}\n`;
  out += `}\n\nexport const schemaValidators = {\n`;
  for (const n of names) {
    const vs = [...reg.get(n)!.vals];
    out += `  ${n}: ${vs.length === 1 ? vs[0] : `(v) => [${vs.join(",")}].some((f) => f(v))`},\n`;
  }
  out += `} satisfies Record<keyof SchemaFieldTypes, (v: unknown) => boolean>;\n`;

  await mkdir("src/generated", { recursive: true });
  await writeFile("src/generated/schema-fields.ts", out);
  console.log(
    `wrote src/generated/schema-fields.ts (${names.length} fields from ${(list.schemas ?? []).length} schema(s))`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
