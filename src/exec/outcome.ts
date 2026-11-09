// Turning an execution result into the case's final status, and running an approved refund end to end.
// Shared by the pipeline (automatic path), the approve endpoint, and the sweeper.

import { and, eq } from "drizzle-orm";
import type { ApprovalRepo } from "../db/approvals.js";
import type { Db } from "../db/client.js";
import { approvals, cases } from "../db/schema.js";
import { executeApprovedRefund } from "./approved.js";
import { minorToDecimal } from "../money.js";
import type { ExecuteResult, ExecutorDeps } from "./executor.js";

export type FinalStatus = "resolved" | "needs_approval" | "NEEDS_HUMAN";

export function describeResult(result: ExecuteResult, mode: "auto" | "approved", why = ""): { status: FinalStatus; reason: string } {
  switch (result.outcome) {
    case "refunded":
      return { status: "resolved", reason: `refunded $${minorToDecimal(result.amountMinor)} (${result.refundId})${why ? `; ${why}` : ""}` };
    case "not_allowed":
      return mode === "auto"
        ? { status: "needs_approval", reason: `executor re-check: ${result.reason}` } // state changed since the decision
        : { status: "NEEDS_HUMAN", reason: `approved refund could not be executed: ${result.reason}` };
    case "unknown":
      return { status: "NEEDS_HUMAN", reason: "PayPal did not answer; the amount is reserved and a retry is safe" };
    case "failed":
      return { status: "NEEDS_HUMAN", reason: `PayPal rejected the refund (${result.paypalStatus})` };
  }
}

export async function setCaseOutcome(db: Db, caseId: string, o: { status: string; reason: string }) {
  await db.update(cases).set({ status: o.status, outcomeReason: o.reason }).where(eq(cases.id, caseId));
}

// Reasons after which an approval can never become valid again.
const DEAD: Record<string, "rejected" | "expired"> = {
  approval_expired: "expired", policy_changed: "rejected", approval_tampered: "rejected", now_denied_by_policy: "rejected",
  exceeds_refundable_balance: "rejected", currency_mismatch: "rejected", order_not_ready: "rejected", approval_context_missing: "rejected",
};

export async function runApproved(deps: ExecutorDeps & { approvals: ApprovalRepo }, approvalId: string) {
  const result = await executeApprovedRefund(deps, approvalId);
  const caseId = await deps.approvals.caseIdFor(approvalId);
  if (result.outcome === "not_allowed" && DEAD[result.reason]) {
    await deps.db.update(approvals).set({ status: DEAD[result.reason] as string }).where(and(eq(approvals.id, approvalId), eq(approvals.status, "approved")));
  }
  const outcome = describeResult(result, "approved");
  if (caseId) await setCaseOutcome(deps.db, caseId, outcome);
  return { result, ...outcome };
}
