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
    uniqueIndex("policies_one_active_uq").on(t.status).where(sql`${t.status} = 'active'`), // at most one active policy
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
    status: text("status").notNull().default("open"), // open | processing | resolved | needs_approval | denied | NEEDS_HUMAN | error
    buyerMessage: text("buyer_message").notNull(),
    outcomeReason: text("outcome_reason"), // plain-language why: the rule that denied it, why a human is needed, the refund id
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("cases_status_idx").on(t.status),
    check("cases_status_ck", sql`${t.status} in ('open','processing','resolved','needs_approval','denied','NEEDS_HUMAN','error')`),
    // One live case per order: blocks double submits and cheap model-spend spam on the same order.
    uniqueIndex("cases_one_active_per_order_uq").on(t.orderId).where(sql`${t.status} in ('open','processing')`),
  ],
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
  claimType: text("claim_type"), // null on rows from before Day 6; treated as "other"
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

// An approval authorises ONE specific refund: params_hash covers {decision, order, remedy, amount}, policy_hash pins the
// policy version, it expires, and it can be used once (I6). Status: pending -> approved -> used, or rejected / expired.
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    decisionId: text("decision_id").notNull().references(() => decisions.id),
    paramsHash: text("params_hash").notNull(),
    policyHash: text("policy_hash").notNull(),
    amountMinor: integer("amount_minor"), // the engine's suggestion while pending; the approved amount once approved
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }), // single use (I6)
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("approvals_decision_uq").on(t.decisionId), // one approval per decision
    check("approvals_status_ck", sql`${t.status} in ('pending','approved','rejected','used','expired')`),
    check("approvals_amount_ck", sql`${t.amountMinor} is null or ${t.amountMinor} > 0`),
    check("approvals_approved_has_amount_ck", sql`${t.status} not in ('approved','used') or ${t.amountMinor} is not null`),
  ],
);

export const executions = pgTable(
  "executions",
  {
    id: id(),
    decisionId: text("decision_id").notNull().references(() => decisions.id),
    idempotencyKey: text("idempotency_key").notNull().unique(), // I7
    requestJson: jsonb("request_json").notNull(),
    responseJson: jsonb("response_json"),
    status: text("status").notNull().default("PENDING"), // PENDING | SUCCEEDED | FAILED | UNKNOWN
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [check("executions_status_ck", sql`${t.status} in ('PENDING','SUCCEEDED','FAILED','UNKNOWN')`)],
);

// A row is RESERVED before we call PayPal (so concurrent proposals see it, I12), then completed with PayPal's
// refund id, or marked failed. Reserved and completed rows count toward caps and the refundable balance.
export const refundLedger = pgTable(
  "refund_ledger",
  {
    id: id(),
    captureId: text("capture_id").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    paypalRefundId: text("paypal_refund_id").unique(), // null only while reserved
    origin: text("origin").notNull(), // countersign | external
    status: text("status").notNull().default("completed"), // reserved | completed | failed
    executionId: text("execution_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("refund_ledger_status_ck", sql`${t.status} in ('reserved','completed','failed')`),
    check("refund_ledger_amount_ck", sql`${t.amountMinor} > 0`),
    check("refund_ledger_completed_has_id_ck", sql`${t.status} <> 'completed' or ${t.paypalRefundId} is not null`),
    index("refund_ledger_capture_idx").on(t.captureId),
  ],
);

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
