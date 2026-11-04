import "dotenv/config";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createOrderRepo, createWebhookRepo } from "./db/repos.js";
import { createPayPalClient } from "./paypal/client.js";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

const app = createApp({
  checkDb: async () => {
    await db.execute(sql`select 1`);
  },
  paypal: createPayPalClient({
    baseUrl: config.PAYPAL_BASE_URL,
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
  }),
  orders: createOrderRepo(db),
  webhooks: createWebhookRepo(db),
  webhookId: config.PAYPAL_WEBHOOK_ID,
  clientId: config.PAYPAL_CLIENT_ID,
  env: config.PAYPAL_ENV,
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`countersign listening on :${info.port}`);
});
