// Throw-away Postgres schema for opt-in integration tests (COUNTERSIGN_DB_TEST=1).
// Applies the real migrations inside a fresh schema on a DIRECT Neon connection and drops it afterwards.
// Refuses to migrate unless search_path is provably the temp schema, so real tables can never be touched.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";

export const dbTestsEnabled = process.env.COUNTERSIGN_DB_TEST === "1" && !!process.env.DATABASE_URL;

export async function setupTempSchema() {
  const schemaName = `cs_test_${randomUUID().slice(0, 8)}`;
  const url = new URL(process.env.DATABASE_URL as string);
  url.hostname = url.hostname.replace("-pooler", ""); // advisory locks + search_path need a direct connection
  const admin = postgres(url.toString(), { max: 1 });
  await admin.unsafe(`create schema ${schemaName}`);
  const client = postgres(url.toString(), { max: 8, connection: { options: `-c search_path=${schemaName}` } }); // Neon ignores a bare search_path param
  try {
    const rows = (await client`show search_path`) as unknown as { search_path: string }[];
    if (rows[0]?.search_path !== schemaName) throw new Error(`refusing to migrate: search_path is "${rows[0]?.search_path}", expected "${schemaName}"`);
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries) {
      // Drizzle writes foreign keys as REFERENCES "public"."x"; point them at the throw-away schema instead.
      const ddl = readFileSync(`drizzle/${tag}.sql`, "utf8").replaceAll('"public".', `"${schemaName}".`);
      if (/\bpublic\b/i.test(ddl)) throw new Error(`refusing to migrate: ${tag}.sql still references public`);
      await client.unsafe(ddl);
    }
  } catch (e) {
    await admin.unsafe(`drop schema if exists ${schemaName} cascade`);
    await client.end();
    await admin.end();
    throw e;
  }
  const db = drizzle(client, { schema }) as unknown as Db;
  return {
    db,
    client,
    schemaName,
    async teardown() {
      await admin.unsafe(`drop schema if exists ${schemaName} cascade`);
      await client.end();
      await admin.end();
    },
  };
}

export const lit = (v: string | number | null) => (v === null ? "null" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`);
