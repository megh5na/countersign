// The executor: the only code path that moves money (I1). It takes NO amount from its caller (I2/I5).
// Phase A (one transaction, under a lock): re-read facts, re-run the policy engine, reserve the amount in the ledger.
// Phase B (outside the transaction): the PayPal call, with an idempotency key derived from the decision (I7).
// A timeout leaves the reservation in place (UNKNOWN); retrying the same decision reuses the key and is safe.

import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { executions, orders, refundLedger } from "../db/schema.js";
import { PayPalError, type PayPalClient } from "../paypal/client.js";
import { buildContext } from "../policy/context.js";
import { loadFacts } from "./facts.js";
import { type Decision, type Proposal, evaluate } from "../policy/engine.js";
import { type Policy, movesMoney } from "../policy/schema.js";

export type ExecutionRow = typeof executions.$inferSelect;

export interface ExecutorDeps {
  db: Db;
  paypal: Pick<PayPalClient, "refundCapture">;
  now?: () => Date;
}

export interface ExecuteRequest {
  decisionId: string; // the audit row that justifies this execution; also the idempotency identity
  orderId: string; // OUR orders.id, resolved from the verified capture handle
  proposal: Proposal;
  policy: Policy;
}

export type ExecuteResult =
  | { outcome: "refunded"; refundId: string; amountMinor: number; replayed: boolean }
  | { outcome: "not_allowed"; reason: string; decision?: Decision }
  | { outcome: "unknown"; amountMinor: number } // PayPal's answer is unknown; amount stays reserved; retry is safe
  | { outcome: "failed"; amountMinor: number; paypalStatus: number };

export const LOCK = sql`select pg_advisory_xact_lock(hashtext('countersign:refund-ledger'))`;
const DEFINITIVE_FAILURES = new Set([400, 404, 422]); // PayPal rejected it; nothing was refunded

export const pgCode = (e: unknown): string | undefined => (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;

type Plan =
  | { kind: "existing"; exec: ExecutionRow }
  | { kind: "not_allowed"; reason: string; decision?: Decision }
  | { kind: "new"; exec: ExecutionRow };

export async function executeRefund(deps: ExecutorDeps, req: ExecuteRequest): Promise<ExecuteResult> {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());
  const key = `refund-${req.decisionId}`;

  // ---- Phase A: decide and reserve, atomically ----
  const plan: Plan = await db.transaction(async (tx) => {
    await tx.execute(LOCK); // serialises every decision-and-reserve; released at commit
    const now = clock(); // read AFTER the lock: we may have waited behind other claims, and the facts must be current
    const [existing] = await tx.select().from(executions).where(eq(executions.idempotencyKey, key));
    if (existing) return { kind: "existing", exec: existing };

    if (!movesMoney(req.proposal.remedy)) return { kind: "not_allowed", reason: "remedy_moves_no_money" };
    const [order] = await tx.select().from(orders).where(eq(orders.id, req.orderId));
    if (!order) return { kind: "not_allowed", reason: "order_not_found" };
    if (!order.captureId) return { kind: "not_allowed", reason: "order_not_captured" };
    if (!order.payerId) return { kind: "not_allowed", reason: "buyer_unknown" }; // per-buyer caps need an identity

    const ctx = buildContext(await loadFacts(tx, order, order.captureId, order.payerId, now));
    const decision = evaluate(req.proposal, ctx, req.policy); // I12: re-evaluated under the lock
    if (decision.decision !== "ALLOW" || decision.amountMinor === null || decision.amountMinor <= 0) {
      return { kind: "not_allowed", reason: decision.decision, decision };
    }

    const exec: ExecutionRow = {
      id: randomUUID(), decisionId: req.decisionId, idempotencyKey: key,
      requestJson: { captureId: order.captureId, amountMinor: decision.amountMinor, currency: order.currency },
      responseJson: null, status: "PENDING", attempts: 0, createdAt: now,
    };
    await tx.insert(executions).values(exec);
    await tx.insert(refundLedger).values({
      id: randomUUID(), captureId: order.captureId, amountMinor: decision.amountMinor, currency: order.currency,
      origin: "countersign", status: "reserved", executionId: exec.id,
    });
    return { kind: "new", exec };
  });

  if (plan.kind === "not_allowed") return { outcome: "not_allowed", reason: plan.reason, decision: plan.decision };
  return settle(deps, plan.exec);
}

// Phase B, shared by the automatic and the approved path: take a reserved execution to its end state.
// Safe to call again on the same execution (retry after UNKNOWN, a crash, or by the sweeper): the key never changes.
export async function settle(deps: Pick<ExecutorDeps, "db" | "paypal">, exec: ExecutionRow): Promise<ExecuteResult> {
  const { db, paypal } = deps;
  const request = exec.requestJson as { captureId: string; amountMinor: number; currency: string };
  if (exec.status === "SUCCEEDED") {
    return { outcome: "refunded", refundId: (exec.responseJson as { id: string }).id, amountMinor: request.amountMinor, replayed: true };
  }
  if (exec.status === "FAILED") return { outcome: "failed", amountMinor: request.amountMinor, paypalStatus: (exec.responseJson as { status: number } | null)?.status ?? 0 };
  // PENDING or UNKNOWN: resume with the SAME key; the reservation is already counted.

  await db.update(executions).set({ attempts: sql`${executions.attempts} + 1` }).where(eq(executions.id, exec.id));
  try {
    const r = await paypal.refundCapture({ ...request, requestId: exec.idempotencyKey });
    await finalizeSuccess(db, exec.id, r);
    return { outcome: "refunded", refundId: r.id, amountMinor: request.amountMinor, replayed: r.replayed };
  } catch (e) {
    if (e instanceof PayPalError && DEFINITIVE_FAILURES.has(e.status)) {
      await db.transaction(async (tx) => {
        await tx.execute(LOCK);
        await tx.update(executions).set({ status: "FAILED", responseJson: { status: e.status, debugId: e.debugId ?? null } }).where(eq(executions.id, exec.id));
        await tx.update(refundLedger).set({ status: "failed" }).where(eq(refundLedger.executionId, exec.id));
      });
      return { outcome: "failed", amountMinor: request.amountMinor, paypalStatus: e.status };
    }
    // Timeout, network error, 5xx, 429, anything unclear: we do not know. Keep the reservation.
    await db.update(executions).set({ status: "UNKNOWN" }).where(eq(executions.id, exec.id));
    return { outcome: "unknown", amountMinor: request.amountMinor };
  }
}

// Record PayPal's refund id. If the refund webhook already inserted this refund as "external", merge into that row
// instead of double counting it. A webhook racing the check surfaces as a unique violation; we retry once.
async function finalizeSuccess(db: Db, executionId: string, r: { id: string }) {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(LOCK);
        await tx.update(executions).set({ status: "SUCCEEDED", responseJson: { id: r.id } }).where(eq(executions.id, executionId));
        const [dup] = await tx.select({ id: refundLedger.id }).from(refundLedger).where(eq(refundLedger.paypalRefundId, r.id));
        if (dup) {
          await tx.delete(refundLedger).where(and(eq(refundLedger.executionId, executionId), eq(refundLedger.status, "reserved")));
          await tx.update(refundLedger).set({ origin: "countersign", executionId }).where(eq(refundLedger.id, dup.id));
        } else {
          await tx.update(refundLedger).set({ paypalRefundId: r.id, status: "completed" }).where(eq(refundLedger.executionId, executionId));
        }
      });
      return;
    } catch (e) {
      if (pgCode(e) === "23505" && attempt < 2) continue;
      throw e;
    }
  }
}
