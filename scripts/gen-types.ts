// Generate TypeScript entity types from the LIVE Stardust schemas.
//
//   STARDUST_URL=http://localhost:1990 node scripts/gen-types.ts
//
// Stardust schemas are standard JSON Schema, so json-schema-to-typescript turns
// each one into an interface (enums → string-literal unions, and so on). We
// refine the bare `type: object` ref/instant fields into named helper types
// via json-schema-to-typescript's `tsType` override.

import { compile } from "json-schema-to-typescript";
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.STARDUST_URL ?? "http://localhost:1990";
const INSTANT_FIELDS = new Set(["due", "at", "endsAt", "startsAt", "committed"]);

// A schema property of `{type:"object"}` with no properties is a Stardust ref
// (or an instant). JSON Schema can't say which, so we apply our conventions.
function refine(schema: any): any {
  for (const [name, prop] of Object.entries<any>(schema.properties ?? {})) {
    if (prop && prop.type === "object" && !prop.properties && !prop.tsType) {
      prop.tsType = INSTANT_FIELDS.has(name) ? "Instant" : "Ref";
    }
  }
  return schema;
}

async function main() {
  const list = (await (await fetch(`${BASE}/schemas`, { headers: { Accept: "application/x-ndjson" } })).json()) as {
    schemas?: string[];
  };
  const urls = list.schemas ?? [];

  let out =
    `// GENERATED from Stardust schemas — do not edit by hand.\n` +
    `// Regenerate:  npm run gen:types   (with Stardust running)\n\n` +
    `export type Ref = { "#": number };\n` +
    `export type Instant = { "#utc": string };\n\n`;

  for (const u of urls) {
    const schema = refine(
      await (await fetch(`${BASE}${u}`, { headers: { Accept: "application/schema+json" } })).json(),
    );
    if (!schema?.title) continue;
    const ts = await compile(schema, schema.title, {
      bannerComment: "",
      additionalProperties: false,
      style: { singleQuote: false },
    });
    out += `${ts.trim()}\n\n`;
  }

  await mkdir("src/generated", { recursive: true });
  await writeFile("src/generated/entities.ts", out);
  console.log(`wrote src/generated/entities.ts from ${urls.length} schema(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
