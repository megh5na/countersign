// server starts. loads env, connects to db, creates repos, creates paypal client, and starts listening for requests
// paypa sandbox settings

import "dotenv/config";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createAnthropicAgentModel } from "./agent/model.js";
import { processCase } from "./agent/pipeline.js";
import { createApprovalRepo } from "./db/approvals.js";
import { createCaseRepo } from "./db/cases.js";
import { createDemoRepo } from "./db/demo.js";
import { createPolicyRepo } from "./db/policies.js";
import { createOrderRepo, createWebhookRepo } from "./db/repos.js";
import { compilePolicy } from "./policy/compiler.js";
import { createAnthropicPolicyLlm } from "./policy/llm.js";
import { runApproved } from "./exec/outcome.js";
import { startSweeper } from "./jobs/sweeper.js";
import { createPayPalClient } from "./paypal/client.js";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

const paypal = createPayPalClient({
  baseUrl: config.PAYPAL_BASE_URL,
  clientId: config.PAYPAL_CLIENT_ID,
  clientSecret: config.PAYPAL_CLIENT_SECRET,
});
const agentModel = config.ANTHROPIC_API_KEY ? createAnthropicAgentModel(config.ANTHROPIC_API_KEY) : undefined;

const approvalRepo = createApprovalRepo(db);

const app = createApp({
  checkDb: async () => {
    await db.execute(sql`select 1`);
  },
  paypal,
  orders: createOrderRepo(db),
  webhooks: createWebhookRepo(db),
  webhookId: config.PAYPAL_WEBHOOK_ID,
  cases: { repo: createCaseRepo(db), run: agentModel ? (caseId) => processCase({ db, model: agentModel, paypal, dailyCapUsd: config.MODEL_DAILY_CAP_USD }, caseId) : undefined },
  approvals: { repo: approvalRepo, run: (id) => runApproved({ db, paypal, approvals: approvalRepo }, id) },
  policies: {
    repo: createPolicyRepo(db),
    compile: config.ANTHROPIC_API_KEY ? (prose) => compilePolicy(prose, createAnthropicPolicyLlm(config.ANTHROPIC_API_KEY as string)) : undefined,
    adminToken: config.ADMIN_TOKEN,
    judgeToken: config.JUDGE_TOKEN,
  },
  demo: { repo: createDemoRepo(db), resetEnabled: config.ALLOW_DEMO_RESET },
  clientId: config.PAYPAL_CLIENT_ID,
  env: config.PAYPAL_ENV,
  trustProxy: config.TRUST_PROXY,
});

startSweeper({ db, paypal, approvals: approvalRepo, model: agentModel, dailyCapUsd: config.MODEL_DAILY_CAP_USD });

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`countersign listening on :${info.port}`);
});
