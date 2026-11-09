// Executing a refund a human approved (invariant I6). Everything is checked in ONE transaction under the ledger lock:
// the approval is still approved, unused and unexpired; the policy is the same version it was approved under; the stored
// parameters still hash to what was reviewed; a DENY rule has not appeared since; the amount fits the refundable balance.
// Only then is the approval marked used (single use) and the amount reserved. The PayPal call is the shared `settle`.

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { approvals, cases, decisions, executions, orders, policies, proposals, refundLedger } from "../db/schema.js";
import { buildContext } from "../policy/context.js";
import { evaluate } from "../policy/engine.js";
import { policyHash } from "../policy/hash.js";
import { ClaimType, Policy } from "../policy/schema.js";
import { LOCK, type ExecuteResult, type ExecutionRow, type ExecutorDeps, settle } from "./executor.js";
import { loadFacts } from "./facts.js";

export const APPROVAL_TTL_MS = 48 * 3_600_000; // an approval request is valid for 48 hours

// What a reviewer is actually approving. Changing any of these changes the hash.
export const approvalParamsHash = (p: { decisionId: string; orderId: string; remedy: string; amountMinor: number | null }) => policyHash(p);

type Plan = { kind: "existing" | "new"; exec: ExecutionRow } | { kind: "refused"; reason: string };

export async function executeApprovedRefund(deps: ExecutorDeps, approvalId: string): Promise<ExecuteResult> {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());
  const refuse = (reason: string): Plan => ({ kind: "refused", reason });

  const plan: Plan = await db.transaction(async (tx) => {
    await tx.execute(LOCK);
    const now = clock(); // after the lock, so expiry and the facts are judged at the moment we actually decide
    const [a] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update");
    if (!a) return refuse("approval_not_found");

    // A previous attempt already reserved this refund: just finish it (same key), never reserve twice.
    const [existing] = await tx.select().from(executions).where(eq(executions.idempotencyKey, `refund-${a.decisionId}`));
    if (existing) return { kind: "existing", exec: existing };

    if (a.status !== "approved" || a.usedAt) return refuse(`approval_${a.status}`);
    if (a.expiresAt.getTime() <= now.getTime()) return refuse("approval_expired");
    if (a.amountMinor === null) return refuse("approval_has_no_amount");

    const [d] = await tx.select().from(decisions).where(eq(decisions.id, a.decisionId));
    const [p] = d ? await tx.select().from(proposals).where(eq(proposals.id, d.proposalId)) : [];
    const [c] = p ? await tx.select().from(cases).where(eq(cases.id, p.caseId)) : [];
    const [order] = c?.orderId ? await tx.select().from(orders).where(eq(orders.id, c.orderId)) : [];
    const [pol] = d ? await tx.select().from(policies).where(eq(policies.id, d.policyId)) : [];
    if (!d || !p || !c || !order || !pol) return refuse("approval_context_missing");

    // Same policy version as when it was reviewed, and that version is still the active one.
    if (pol.status !== "active" || pol.rulesHash !== a.policyHash) return refuse("policy_changed");
    // The parameters in the database must still be the ones that were reviewed.
    if (approvalParamsHash({ decisionId: d.id, orderId: order.id, remedy: p.remedy, amountMinor: a.amountMinor }) !== a.paramsHash) return refuse("approval_tampered");
    if (!order.captureId || !order.payerId) return refuse("order_not_ready");

    const policy = Policy.parse(pol.rulesJson);
    const claim = ClaimType.safeParse(p.claimType);
    const proposal = { claimType: claim.success ? claim.data : ("other" as const), remedy: p.remedy as never };
    const ctx = buildContext(await loadFacts(tx, order, order.captureId, order.payerId, now));

    // A human can authorise what the policy merely asks about, but cannot override a DENY (change the policy for that).
    if (evaluate(proposal, ctx, policy).decision === "DENY") return refuse("now_denied_by_policy");
    if (ctx.currency !== policy.currency) return refuse("currency_mismatch");
    if (a.amountMinor > ctx.refundableMinor) return refuse("exceeds_refundable_balance"); // I5

    await tx.update(approvals).set({ status: "used", usedAt: now }).where(eq(approvals.id, a.id)); // single use
    const exec: ExecutionRow = {
      id: randomUUID(), decisionId: d.id, idempotencyKey: `refund-${d.id}`,
      requestJson: { captureId: order.captureId, amountMinor: a.amountMinor, currency: order.currency },
      responseJson: null, status: "PENDING", attempts: 0, createdAt: now,
    };
    await tx.insert(executions).values(exec);
    await tx.insert(refundLedger).values({
      id: randomUUID(), captureId: order.captureId, amountMinor: a.amountMinor, currency: order.currency,
      origin: "countersign", status: "reserved", executionId: exec.id,
    });
    return { kind: "new", exec };
  });

  if (plan.kind === "refused") return { outcome: "not_allowed", reason: plan.reason };
  return settle(deps, plan.exec);
}
