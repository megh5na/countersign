// npm run seed: installs the demo policy on a fresh database. Safe to run repeatedly.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { seedDemoPolicy } from "../src/db/seed.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = createDb(url);
try {
  await db.execute(sql`select 1 from policies limit 1`);
} catch {
  console.error("The policies table does not exist yet. Run: npm run db:migrate");
  process.exit(1);
}
const r = await seedDemoPolicy(db);
console.log(r.seeded ? `Seeded the demo policy as version ${r.version}.` : `Nothing to do: ${r.reason} (version ${r.version}).`);
process.exit(0);
