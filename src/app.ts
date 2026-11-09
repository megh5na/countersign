// checks db connectivity, client id, api routes and mounts webhook endpoint.

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { OrderRepo, WebhookRepo } from "./db/repos.js";
import type { PayPalClient } from "./paypal/client.js";
import type { ApprovalRepo } from "./db/approvals.js";
import type { CaseRepo } from "./db/cases.js";
import type { DemoRepo } from "./db/demo.js";
import type { PolicyRepo } from "./db/policies.js";
import type { CompileReport } from "./policy/compiler.js";
import { clientIp, createRateLimiter, limit } from "./http/rateLimit.js";
import { adminRoutes } from "./routes/admin.js";
import { caseRoutes } from "./routes/cases.js";
import { policyRoutes } from "./routes/policies.js";
import { storeRoutes } from "./routes/store.js";
import { webhookRoutes } from "./routes/webhooks.js";

export interface AppDeps {
  checkDb: () => Promise<void>;
  paypal: Pick<PayPalClient, "createOrder" | "captureOrder" | "verifyWebhook">;
  orders: OrderRepo;
  webhooks: WebhookRepo;
  webhookId?: string;
  cases: { repo: CaseRepo; run?: (caseId: string) => Promise<unknown> };
  approvals: { repo: ApprovalRepo; run?: (approvalId: string) => Promise<{ status: string; reason: string }> };
  policies: { repo: PolicyRepo; compile?: (prose: string) => Promise<CompileReport>; adminToken?: string; judgeToken?: string };
  demo?: { repo: DemoRepo; resetEnabled: boolean };
  clientId: string; // safe for the browser; the secret never leaves the server
  env: string;
  trustProxy?: boolean; // true only behind a proxy we control; decides where rate limits read the client address
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

  // Rate limits on the public, money- and model-spending endpoints (see src/http/rateLimit.ts).
  const HOUR = 3_600_000;
  const ip = (c: Parameters<typeof clientIp>[0]) => clientIp(c, deps.trustProxy ?? false);
  app.use("/api/orders", limit(createRateLimiter({ windowMs: HOUR, max: 20 }), ip));
  app.use("/api/orders/*", limit(createRateLimiter({ windowMs: HOUR, max: 40 }), ip));
  app.use("/api/cases", limit(createRateLimiter({ windowMs: HOUR, max: 10 }), ip));
  app.use("/api/cases", limit(createRateLimiter({ windowMs: 24 * HOUR, max: 150 }), () => "all")); // total claims per day, whoever sends them
  app.use("/webhooks/paypal", limit(createRateLimiter({ windowMs: 60_000, max: 300 }), ip));

  app.get("/api/config", (c) => c.json({ clientId: deps.clientId }));
  app.route("/api", storeRoutes({ paypal: deps.paypal, orders: deps.orders }));
  app.route("/api/policies", policyRoutes(deps.policies));
  app.route("/api/cases", caseRoutes({ cases: deps.cases.repo, run: deps.cases.run }));
  app.route("/api/admin", adminRoutes({ cases: deps.cases.repo, approvals: deps.approvals.repo, runApproved: deps.approvals.run, adminToken: deps.policies.adminToken, judgeToken: deps.policies.judgeToken, demo: deps.demo?.repo, resetEnabled: deps.demo?.resetEnabled }));
  app.route("/webhooks/paypal", webhookRoutes({ paypal: deps.paypal, repo: deps.webhooks, webhookId: deps.webhookId }));

  app.use("/*", serveStatic({ root: "./public" })); // demo store; must stay last
  return app;
}
