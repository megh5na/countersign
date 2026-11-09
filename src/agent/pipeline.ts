// Case pipeline: claim -> agent (proposes) -> policy engine (decides) -> executor (acts).
// Every step leaves rows behind (agent_runs, tool_calls, proposals, decisions, executions) so the timeline can be rebuilt.
// The model's only influence on money is the claim type and remedy tier it proposes; the engine and executor take it from there.

import { randomUUID } from "node:crypto";
import { eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { createPolicyRepo } from "../db/policies.js";
import { createApprovalRepo } from "../db/approvals.js";
import { agentRuns, cases, decisions, orders, proposals, toolCalls } from "../db/schema.js";
import { APPROVAL_TTL_MS } from "../exec/approved.js";
import { executeRefund } from "../exec/executor.js";
import { loadFacts } from "../exec/facts.js";
import { describeResult } from "../exec/outcome.js";
import type { PayPalClient } from "../paypal/client.js";
import { buildContext } from "../policy/context.js";
import { evaluate } from "../policy/engine.js";
import { policyHash } from "../policy/hash.js";
import { Policy, movesMoney } from "../policy/schema.js";
import { type AgentModel, runAgent } from "./agent.js";
import { createAgentData } from "./data.js";

// Claude Sonnet 5.5 list prices, US dollars per million tokens. Used only to estimate spend against the daily cap.
export const AGENT_PRICE_PER_M = { input: 2, output: 10 } as const;

export interface PipelineDeps {
  db: Db;
  model: AgentModel;
  paypal: Pick<PayPalClient, "refundCapture">;
  modelName?: string;
  now?: () => Date;
  dailyCapUsd?: number; // when set, no new agent run starts once today's (UTC) estimated spend reaches this
}

export async function modelSpendTodayUsd(db: Db, now: Date): Promise<number> {
  const startOfUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({ tin: sql<number>`coalesce(sum(${agentRuns.tokensIn}), 0)`, tout: sql<number>`coalesce(sum(${agentRuns.tokensOut}), 0)` })
    .from(agentRuns)
    .where(gte(agentRuns.createdAt, startOfUtcDay));
  return (Number(row?.tin ?? 0) * AGENT_PRICE_PER_M.input + Number(row?.tout ?? 0) * AGENT_PRICE_PER_M.output) / 1_000_000;
}

export type CaseStatus = "resolved" | "needs_approval" | "denied" | "NEEDS_HUMAN" | "error" | "skipped";
export interface PipelineResult {
  status: CaseStatus;
  reason: string;
  decisionId?: string;
}

export async function processCase(deps: PipelineDeps, caseId: string): Promise<PipelineResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();

  const finish = async (status: Exclude<CaseStatus, "skipped">, reason: string, decisionId?: string): Promise<PipelineResult> => {
    await db.update(cases).set({ status, outcomeReason: reason }).where(eq(cases.id, caseId));
    return { status, reason, decisionId };
  };

  // Claim the case: only one worker can move it from open to processing.
  const claimed = await db.update(cases).set({ status: "processing" }).where(sql`${cases.id} = ${caseId} and ${cases.status} = 'open'`).returning({ orderId: cases.orderId, buyerMessage: cases.buyerMessage });
  const c = claimed[0];
  if (!c) return { status: "skipped", reason: "case is not open" };

  try {
    if (!c.orderId) return await finish("NEEDS_HUMAN", "case has no order");
    const [order] = await db.select().from(orders).where(eq(orders.id, c.orderId));
    if (!order?.captureId || !order.payerId) return await finish("NEEDS_HUMAN", "order has no captured payment or known buyer");

    const active = await createPolicyRepo(db).getActive();
    if (!active) return await finish("NEEDS_HUMAN", "no active policy: activate one first");
    const policy = Policy.parse(active.rulesJson);

    // Spend guard: once the day's model budget is used up, new cases wait for a human instead of calling the model.
    if (deps.dailyCapUsd !== undefined) {
      const spent = await modelSpendTodayUsd(db, now);
      if (spent >= deps.dailyCapUsd) return await finish("NEEDS_HUMAN", `daily AI spend cap reached ($${spent.toFixed(2)} of $${deps.dailyCapUsd.toFixed(2)}); this case needs a human`);
    }

    // ---- 1. The agent investigates and proposes (it can read; it cannot act) ----
    const run = await runAgent({ model: deps.model, data: createAgentData(db), now: () => now }, { orderId: order.id, buyerMessage: c.buyerMessage, policyRules: policy });
    const runId = randomUUID();
    await db.insert(agentRuns).values({
      id: runId, caseId, model: deps.modelName ?? "claude-sonnet-5-5", tokensIn: run.tokensIn, tokensOut: run.tokensOut,
      transcriptJson: run.messages, outcome: run.outcome.kind === "proposal" ? "proposal" : `needs_human:${run.outcome.reason}`,
    });
    for (const t of run.toolCalls) {
      await db.insert(toolCalls).values({ id: `${runId}:${t.id}`, runId, name: t.name, argsJson: t.args, resultJson: t.result, handlesJson: t.handles });
    }
    if (run.outcome.kind === "needs_human") return await finish("NEEDS_HUMAN", `agent: ${run.outcome.reason}`);
    const p = run.outcome.proposal;

    // ---- 2. Record the proposal; the rationale lives only in the transcript and is never read by the engine (I3) ----
    const proposalId = randomUUID();
    await db.insert(proposals).values({
      id: proposalId, caseId, runId, claimType: p.claimType, remedy: p.remedy, captureHandle: p.captureHandle,
      paramsHash: policyHash({ claimType: p.claimType, remedy: p.remedy, orderId: p.orderId }), messageDraft: p.buyerMessageDraft,
    });

    // ---- 3. The engine decides, from facts WE load (not from anything the model saw) ----
    const proposal = { claimType: p.claimType, remedy: p.remedy };
    const ctx = buildContext(await loadFacts(db, order, order.captureId, order.payerId, now));
    const decision = evaluate(proposal, ctx, policy);
    const decisionId = randomUUID();
    await db.insert(decisions).values({
      id: decisionId, proposalId, policyId: active.id, decision: decision.decision, amountMinor: decision.amountMinor,
      ruleIds: decision.ruleIds, contextJson: { context: ctx, reasons: decision.reasons },
    });

    const why = `${decision.ruleIds.join("+")}${decision.reasons.length ? `: ${decision.reasons.join("; ")}` : ""}`;
    if (p.remedy === "escalate") return await finish("NEEDS_HUMAN", "agent escalated", decisionId);
    if (decision.decision === "DENY") return await finish("denied", why, decisionId);
    // A money refund that needs a human gets an approval request bound to these exact parameters (I6).
    const askForApproval = () =>
      createApprovalRepo(db).create({
        decisionId, orderId: order.id, remedy: p.remedy, amountMinor: decision.amountMinor, policyHash: active.rulesHash,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      });
    if (decision.decision === "REQUIRE_APPROVAL") {
      if (!movesMoney(p.remedy)) return await finish("NEEDS_HUMAN", `${why}; no refund involved, handle this one manually`, decisionId);
      await askForApproval();
      return await finish("needs_approval", why, decisionId);
    }

    // ---- 4. ALLOW: money-moving remedies go through the executor, which re-checks everything under a lock ----
    if (!movesMoney(p.remedy)) return await finish("resolved", `${p.remedy}: no money moved (${why})`, decisionId);
    // The executor reads its own clock under the lock. Passing this pipeline's `now` (taken before a ~30 s agent run) would be stale.
    const exec = await executeRefund({ db, paypal: deps.paypal, now: deps.now }, { decisionId, orderId: order.id, proposal, policy });
    if (exec.outcome === "not_allowed") {
      await askForApproval(); // the facts changed between the decision and the lock; a human should look
      return await finish("needs_approval", `executor re-check: ${exec.reason}`, decisionId);
    }
    const o = describeResult(exec, "auto", why);
    return await finish(o.status, o.reason, decisionId);
  } catch (e) {
    console.error("case pipeline failed:", caseId, e instanceof Error ? e.message : "unknown error");
    return await finish("error", "internal error; see server logs");
  }
}
