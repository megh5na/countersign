// Approvals inbox storage. The merchant approves a specific refund; nothing here moves money (that is exec/approved.ts).

import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { APPROVAL_TTL_MS, approvalParamsHash } from "../exec/approved.js";
import { loadFacts } from "../exec/facts.js";
import { buildContext } from "../policy/context.js";
import type { Db } from "./client.js";
import { agentRuns, approvals, cases, decisions, orders, policies, proposals } from "./schema.js";

export interface ApprovalView {
  id: string;
  status: string;
  paramsHash: string; // what the reviewer must echo back when approving: proves they saw this exact version
  suggestedAmountMinor: number | null; // the engine's suggestion; the approved amount once approved
  expiresAt: Date;
  createdAt: Date;
  caseId: string;
  paypalOrderId: string;
  orderTotalMinor: number;
  remedy: string;
  claimType: string | null;
  buyerMessage: string;
  agentDraft: string; // the model's suggested reply, for the merchant to edit and send; never sent automatically
  ruleIds: unknown;
  reasons: unknown;
}

export type ApproveResult =
  | { ok: true; amountMinor: number }
  | { ok: false; error: "not_found" | "not_pending" | "expired" | "hash_mismatch" | "amount_required" | "exceeds_refundable" | "order_not_ready" };
export type ManualRemedy = "full_refund" | "partial_tier_a" | "partial_tier_b";
export type ManualResult =
  | { ok: true; approvalId: string; paramsHash: string; amountMinor: number }
  | { ok: false; error: "not_found" | "not_resolvable" | "no_agent_run" | "no_policy" | "order_not_ready" | "exceeds_refundable" };
export type RejectResult = { ok: true } | { ok: false; error: "not_found" | "not_pending" | "hash_mismatch" };

export interface ApprovalRepo {
  create(a: { decisionId: string; orderId: string; remedy: string; amountMinor: number | null; policyHash: string; expiresAt: Date }): Promise<string | null>;
  list(status?: string): Promise<ApprovalView[]>;
  get(id: string): Promise<ApprovalView | undefined>;
  // Merchant-initiated refund for an escalated (NEEDS_HUMAN) case. It becomes an ordinary pending approval, so the
  // same hash, expiry, single-use, policy-pin and DENY re-check protections apply when it is confirmed and executed.
  createManual(caseId: string, input: { remedy: ManualRemedy; amountMinor: number }, now?: Date): Promise<ManualResult>;
  approve(id: string, input: { paramsHash: string; amountMinor?: number }, now?: Date): Promise<ApproveResult>;
  reject(id: string, paramsHash: string, now?: Date): Promise<RejectResult>;
  caseIdFor(approvalId: string): Promise<string | undefined>;
}

export function createApprovalRepo(db: Db): ApprovalRepo {
  const viewQuery = () =>
    db
      .select({
        id: approvals.id, status: approvals.status, paramsHash: approvals.paramsHash, suggestedAmountMinor: approvals.amountMinor,
        expiresAt: approvals.expiresAt, createdAt: approvals.createdAt, caseId: cases.id, paypalOrderId: orders.paypalOrderId,
        orderTotalMinor: orders.amountMinor, remedy: proposals.remedy, claimType: proposals.claimType, buyerMessage: cases.buyerMessage,
        agentDraft: proposals.messageDraft, ruleIds: decisions.ruleIds, contextJson: decisions.contextJson,
      })
      .from(approvals)
      .innerJoin(decisions, eq(approvals.decisionId, decisions.id))
      .innerJoin(proposals, eq(decisions.proposalId, proposals.id))
      .innerJoin(cases, eq(proposals.caseId, cases.id))
      .innerJoin(orders, eq(cases.orderId, orders.id));
  const toView = ({ contextJson, ...v }: Awaited<ReturnType<typeof viewQuery>>[number]): ApprovalView => ({
    ...v, reasons: (contextJson as { reasons?: unknown } | null)?.reasons ?? [],
  });

  return {
    async create(a) {
      const rows = await db
        .insert(approvals)
        .values({
          id: randomUUID(), decisionId: a.decisionId, policyHash: a.policyHash, amountMinor: a.amountMinor, expiresAt: a.expiresAt,
          paramsHash: approvalParamsHash({ decisionId: a.decisionId, orderId: a.orderId, remedy: a.remedy, amountMinor: a.amountMinor }),
        })
        .onConflictDoNothing({ target: approvals.decisionId })
        .returning({ id: approvals.id });
      return rows[0]?.id ?? null;
    },

    async list(status) {
      const rows = await (status ? viewQuery().where(eq(approvals.status, status)) : viewQuery()).orderBy(desc(approvals.createdAt));
      return rows.map(toView);
    },

    async get(id) {
      const [row] = await viewQuery().where(eq(approvals.id, id));
      return row && toView(row);
    },

    async createManual(caseId, input, now = new Date()) {
      return db.transaction(async (tx) => {
        const [c] = await tx.select().from(cases).where(eq(cases.id, caseId)).for("update");
        if (!c) return { ok: false, error: "not_found" } as const;
        if (c.status !== "NEEDS_HUMAN") return { ok: false, error: "not_resolvable" } as const;
        const [order] = c.orderId ? await tx.select().from(orders).where(eq(orders.id, c.orderId)) : [];
        if (!order?.captureId || !order.payerId) return { ok: false, error: "order_not_ready" } as const;
        const [run] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.caseId, caseId)).orderBy(desc(agentRuns.createdAt)).limit(1);
        if (!run) return { ok: false, error: "no_agent_run" } as const; // proposals need a run; a case that never reached the agent cannot be resolved here
        const [pol] = await tx.select().from(policies).where(eq(policies.status, "active"));
        if (!pol) return { ok: false, error: "no_policy" } as const;
        const [prev] = await tx.select({ claimType: proposals.claimType }).from(proposals).where(eq(proposals.caseId, caseId)).orderBy(desc(proposals.createdAt)).limit(1);

        const ctx = buildContext(await loadFacts(tx, order, order.captureId, order.payerId, now));
        if (input.amountMinor > ctx.refundableMinor) return { ok: false, error: "exceeds_refundable" } as const;

        const proposalId = randomUUID(), decisionId = randomUUID(), approvalId = randomUUID();
        const paramsHash = approvalParamsHash({ decisionId, orderId: order.id, remedy: input.remedy, amountMinor: input.amountMinor });
        await tx.insert(proposals).values({
          id: proposalId, caseId, runId: run.id, claimType: prev?.claimType ?? "other", remedy: input.remedy, captureHandle: "manual",
          paramsHash, messageDraft: "Resolved manually by the merchant.",
        });
        await tx.insert(decisions).values({
          id: decisionId, proposalId, policyId: pol.id, decision: "REQUIRE_APPROVAL", amountMinor: input.amountMinor, ruleIds: ["MANUAL"],
          contextJson: { context: ctx, reasons: ["proposed by the merchant for an escalated case"], manual: true },
        });
        await tx.insert(approvals).values({
          id: approvalId, decisionId, paramsHash, policyHash: pol.rulesHash, amountMinor: input.amountMinor, expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
        });
        await tx.update(cases).set({ status: "needs_approval", outcomeReason: "manual refund proposed by the merchant; awaiting confirmation" }).where(eq(cases.id, caseId));
        return { ok: true, approvalId, paramsHash, amountMinor: input.amountMinor } as const;
      });
    },

    async approve(id, input, now = new Date()) {
      return db.transaction(async (tx) => {
        const [a] = await tx.select().from(approvals).where(eq(approvals.id, id)).for("update");
        if (!a) return { ok: false, error: "not_found" } as const;
        if (a.status !== "pending") return { ok: false, error: "not_pending" } as const;
        if (a.expiresAt.getTime() <= now.getTime()) return { ok: false, error: "expired" } as const;
        if (a.paramsHash !== input.paramsHash) return { ok: false, error: "hash_mismatch" } as const;

        const amountMinor = input.amountMinor ?? a.amountMinor;
        if (amountMinor === null || amountMinor === undefined) return { ok: false, error: "amount_required" } as const;

        const [d] = await tx.select().from(decisions).where(eq(decisions.id, a.decisionId));
        const [p] = d ? await tx.select().from(proposals).where(eq(proposals.id, d.proposalId)) : [];
        const [c] = p ? await tx.select().from(cases).where(eq(cases.id, p.caseId)) : [];
        const [order] = c?.orderId ? await tx.select().from(orders).where(eq(orders.id, c.orderId)) : [];
        if (!d || !p || !order?.captureId || !order.payerId) return { ok: false, error: "order_not_ready" } as const;

        const ctx = buildContext(await loadFacts(tx, order, order.captureId, order.payerId, now));
        if (amountMinor > ctx.refundableMinor) return { ok: false, error: "exceeds_refundable" } as const; // early, friendly; re-checked at execution (I5)

        await tx
          .update(approvals)
          .set({
            amountMinor, status: "approved", decidedAt: now,
            paramsHash: approvalParamsHash({ decisionId: d.id, orderId: order.id, remedy: p.remedy, amountMinor }), // binds the FINAL amount
          })
          .where(and(eq(approvals.id, id), eq(approvals.status, "pending")));
        return { ok: true, amountMinor } as const;
      });
    },

    async reject(id, paramsHash, now = new Date()) {
      return db.transaction(async (tx) => {
        const [a] = await tx.select().from(approvals).where(eq(approvals.id, id)).for("update");
        if (!a) return { ok: false, error: "not_found" } as const;
        if (a.status !== "pending") return { ok: false, error: "not_pending" } as const;
        if (a.paramsHash !== paramsHash) return { ok: false, error: "hash_mismatch" } as const;
        await tx.update(approvals).set({ status: "rejected", decidedAt: now }).where(eq(approvals.id, id));
        const [d] = await tx.select({ proposalId: decisions.proposalId }).from(decisions).where(eq(decisions.id, a.decisionId));
        const [p] = d ? await tx.select({ caseId: proposals.caseId }).from(proposals).where(eq(proposals.id, d.proposalId)) : [];
        if (p) await tx.update(cases).set({ status: "denied", outcomeReason: "rejected by the merchant" }).where(eq(cases.id, p.caseId));
        return { ok: true } as const;
      });
    },

    async caseIdFor(approvalId) {
      const [row] = await db
        .select({ caseId: proposals.caseId })
        .from(approvals)
        .innerJoin(decisions, eq(approvals.decisionId, decisions.id))
        .innerJoin(proposals, eq(decisions.proposalId, proposals.id))
        .where(eq(approvals.id, approvalId));
      return row?.caseId;
    },
  };
}
