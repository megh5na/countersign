import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Invariant I8: all money is integer minor units + a currency code. Never floats.
const id = () => text("id").primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const policies = pgTable(
  "policies",
  {
    id: id(),
    version: integer("version").notNull(),
    sourceText: text("source_text").notNull(),
    rulesJson: jsonb("rules_json").notNull(),
    rulesHash: text("rules_hash").notNull(),
    testCasesJson: jsonb("test_cases_json").notNull(),
    status: text("status").notNull().default("draft"), // draft | active | retired
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("policies_version_uq").on(t.version),
    check("policies_status_ck", sql`${t.status} in ('draft','active','retired')`),
  ],
);

export const orders = pgTable("orders", {
  id: id(),
  paypalOrderId: text("paypal_order_id").notNull().unique(),
  captureId: text("capture_id").unique(),
  payerId: text("payer_id"),
  buyerEmail: text("buyer_email"),
  amountMinor: integer("amount_minor").notNull(),
  currency: text("currency").notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  trackingNo: text("tracking_no"),
  createdAt: createdAt(),
});

export const cases = pgTable(
  "cases",
  {
    id: id(),
    source: text("source").notNull(), // form | dispute
    orderId: text("order_id").references(() => orders.id),
    disputeId: text("dispute_id").unique(),
    stage: text("stage"),
    status: text("status").notNull().default("open"), // open | NEEDS_HUMAN | resolved ...
    buyerMessage: text("buyer_message").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("cases_status_idx").on(t.status)],
);

export const agentRuns = pgTable("agent_runs", {
  id: id(),
  caseId: text("case_id").notNull().references(() => cases.id),
  model: text("model").notNull(),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  transcriptJson: jsonb("transcript_json").notNull(),
  outcome: text("outcome"),
  createdAt: createdAt(),
});

export const toolCalls = pgTable("tool_calls", {
  id: id(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  name: text("name").notNull(),
  argsJson: jsonb("args_json").notNull(),
  resultJson: jsonb("result_json").notNull(),
  handlesJson: jsonb("handles_json").notNull(), // handle -> real PayPal id; the only IDs the agent may cite
  createdAt: createdAt(),
});

export const proposals = pgTable("proposals", {
  id: id(),
  caseId: text("case_id").notNull().references(() => cases.id),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  remedy: text("remedy").notNull(),
  captureHandle: text("capture_handle").notNull(),
  paramsHash: text("params_hash").notNull(),
  messageDraft: text("message_draft").notNull(),
  createdAt: createdAt(),
});

export const decisions = pgTable("decisions", {
  id: id(),
  proposalId: text("proposal_id").notNull().references(() => proposals.id),
  policyId: text("policy_id").notNull().references(() => policies.id),
  decision: text("decision").notNull(), // ALLOW | REQUIRE_APPROVAL | DENY
  amountMinor: integer("amount_minor"),
  ruleIds: jsonb("rule_ids").notNull(),
  contextJson: jsonb("context_json").notNull(),
  createdAt: createdAt(),
});

export const approvals = pgTable("approvals", {
  id: id(),
  decisionId: text("decision_id").notNull().references(() => decisions.id),
  paramsHash: text("params_hash").notNull(),
  policyHash: text("policy_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }), // single use (I6)
  status: text("status").notNull().default("pending"),
});

export const executions = pgTable("executions", {
  id: id(),
  decisionId: text("decision_id").notNull().references(() => decisions.id),
  idempotencyKey: text("idempotency_key").notNull().unique(), // I7
  requestJson: jsonb("request_json").notNull(),
  responseJson: jsonb("response_json"),
  status: text("status").notNull().default("PENDING"), // PENDING | SUCCEEDED | FAILED | UNKNOWN
  attempts: integer("attempts").notNull().default(0),
  createdAt: createdAt(),
});

export const refundLedger = pgTable("refund_ledger", {
  id: id(),
  captureId: text("capture_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: text("currency").notNull(),
  paypalRefundId: text("paypal_refund_id").notNull().unique(),
  origin: text("origin").notNull(), // countersign | external
  createdAt: createdAt(),
});

export const webhookEvents = pgTable("webhook_events", {
  id: id(),
  paypalEventId: text("paypal_event_id").notNull().unique(), // I9: exactly-once
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  verified: integer("verified").notNull().default(0),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const auditLog = pgTable("audit_log", {
  id: id(),
  caseId: text("case_id").references(() => cases.id),
  actor: text("actor").notNull(),
  event: text("event").notNull(),
  dataJson: jsonb("data_json").notNull(),
  prevHash: text("prev_hash"),
  hash: text("hash").notNull(),
  createdAt: createdAt(),
});
