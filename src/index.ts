import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

export const app = new Hono();

app.get("/health", async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ ok: true, db: "up", env: config.PAYPAL_ENV });
  } catch {
    return c.json({ ok: false, db: "down" }, 503);
  }
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`countersign listening on :${info.port}`);
});
