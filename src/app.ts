// checks db connectivity, client id, api routes and mounts webhook endpoint.

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { OrderRepo, WebhookRepo } from "./db/repos.js";
import type { PayPalClient } from "./paypal/client.js";
import type { PolicyRepo } from "./db/policies.js";
import type { CompileReport } from "./policy/compiler.js";
import { policyRoutes } from "./routes/policies.js";
import { storeRoutes } from "./routes/store.js";
import { webhookRoutes } from "./routes/webhooks.js";

export interface AppDeps {
  checkDb: () => Promise<void>;
  paypal: Pick<PayPalClient, "createOrder" | "captureOrder" | "verifyWebhook">;
  orders: OrderRepo;
  webhooks: WebhookRepo;
  webhookId?: string;
  policies: { repo: PolicyRepo; compile?: (prose: string) => Promise<CompileReport>; adminToken?: string };
  clientId: string; // safe for the browser; the secret never leaves the server
  env: string;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get("/health", async (c) => {
    try {
      await deps.checkDb();
      return c.json({ ok: true, db: "up", env: deps.env });
    } catch {
      return c.json({ ok: false, db: "down" }, 503);
    }
  });

  app.get("/api/config", (c) => c.json({ clientId: deps.clientId }));
  app.route("/api", storeRoutes({ paypal: deps.paypal, orders: deps.orders }));
  app.route("/api/policies", policyRoutes(deps.policies));
  app.route("/webhooks/paypal", webhookRoutes({ paypal: deps.paypal, repo: deps.webhooks, webhookId: deps.webhookId }));

  app.use("/*", serveStatic({ root: "./public" })); // demo store; must stay last
  return app;
}
