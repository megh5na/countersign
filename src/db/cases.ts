// Case storage for the support form and the merchant's timeline view.

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentRuns, cases, decisions, executions, orders, proposals, toolCalls } from "./schema.js";

export type OpenResult = { ok: true; caseId: string } | { ok: false; error: "unknown_order" | "not_captured" | "duplicate_active" };

export interface CaseListItem {
  id: string;
  status: string;
  outcomeReason: string | null;
  createdAt: Date;
  paypalOrderId: string | null;
  buyerMessage: string; // shortened for the list; the timeline has the full text
  decision: { decision: string; amountMinor: number | null; ruleIds: unknown } | null; // the latest engine decision, if any
}

export type DeclineResult = "declined" | "not_found" | "not_declinable";

export interface CaseRepo {
  list(status?: string, limit?: number): Promise<CaseListItem[]>;
  decline(caseId: string): Promise<DeclineResult>;
  open(paypalOrderId: string, message: string): Promise<OpenResult>;
  status(caseId: string): Promise<{ status: string } | undefined>;
  timeline(caseId: string): Promise<unknown | undefined>;
  markDelivered(paypalOrderId: string, daysAgo: number): Promise<boolean>;
}

const pgCode = (e: unknown): string | undefined => (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;

export function createCaseRepo(db: Db): CaseRepo {
  return {
    async list(status, limit = 100) {
      const rows = await db
        .select({ id: cases.id, status: cases.status, outcomeReason: cases.outcomeReason, createdAt: cases.createdAt, paypalOrderId: orders.paypalOrderId, buyerMessage: cases.buyerMessage })
        .from(cases)
        .leftJoin(orders, eq(cases.orderId, orders.id))
        .where(status ? eq(cases.status, status) : undefined)
        .orderBy(desc(cases.createdAt))
        .limit(Math.min(limit, 200));
      if (rows.length === 0) return [];
      const decs = await db
        .select({ caseId: proposals.caseId, decision: decisions.decision, amountMinor: decisions.amountMinor, ruleIds: decisions.ruleIds, createdAt: decisions.createdAt })
        .from(decisions)
        .innerJoin(proposals, eq(decisions.proposalId, proposals.id))
        .where(inArray(proposals.caseId, rows.map((r) => r.id)))
        .orderBy(desc(decisions.createdAt));
      const latest = new Map<string, (typeof decs)[number]>();
      for (const d of decs) if (!latest.has(d.caseId)) latest.set(d.caseId, d); // newest first, so the first seen wins
      return rows.map((r) => {
        const d = latest.get(r.id);
        return { ...r, buyerMessage: r.buyerMessage.length > 240 ? `${r.buyerMessage.slice(0, 237)}...` : r.buyerMessage, decision: d ? { decision: d.decision, amountMinor: d.amountMinor, ruleIds: d.ruleIds } : null };
      });
    },

    // The merchant declines an escalated case: it closes as denied. (A pending approval is rejected through the approvals API instead.)
    async decline(caseId) {
      const done = await db
        .update(cases)
        .set({ status: "denied", outcomeReason: "declined by the merchant" })
        .where(and(eq(cases.id, caseId), eq(cases.status, "NEEDS_HUMAN")))
        .returning({ id: cases.id });
      if (done.length) return "declined";
      const [c] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId));
      return c ? "not_declinable" : "not_found";
    },

    async open(paypalOrderId, message) {
      const [order] = await db.select({ id: orders.id, captureId: orders.captureId }).from(orders).where(eq(orders.paypalOrderId, paypalOrderId));
      if (!order) return { ok: false, error: "unknown_order" };
      if (!order.captureId) return { ok: false, error: "not_captured" };
      const caseId = randomUUID();
      try {
        await db.insert(cases).values({ id: caseId, source: "form", orderId: order.id, buyerMessage: message });
      } catch (e) {
        if (pgCode(e) === "23505") return { ok: false, error: "duplicate_active" }; // cases_one_active_per_order_uq
        throw e;
      }
      return { ok: true, caseId };
    },

    async status(caseId) {
      const [c] = await db.select({ status: cases.status }).from(cases).where(eq(cases.id, caseId));
      return c;
    },

    async timeline(caseId) {
      // The queries depend on each other only along two short chains, so run them side by side (the database is remote).
      const [[c], runs, props] = await Promise.all([
        db.select().from(cases).where(eq(cases.id, caseId)),
        db.select().from(agentRuns).where(eq(agentRuns.caseId, caseId)),
        db.select().from(proposals).where(eq(proposals.caseId, caseId)),
      ]);
      if (!c) return undefined;
      const runIds = runs.map((r) => r.id);
      const propIds = props.map((p) => p.id);
      const [calls, [decs, execs]] = await Promise.all([
        runIds.length ? db.select().from(toolCalls).where(inArray(toolCalls.runId, runIds)) : Promise.resolve([]),
        (async () => {
          const d = propIds.length ? await db.select().from(decisions).where(inArray(decisions.proposalId, propIds)) : [];
          const decIds = d.map((x) => x.id);
          const e = decIds.length ? await db.select().from(executions).where(inArray(executions.decisionId, decIds)) : [];
          return [d, e] as const;
        })(),
      ]);
      return {
        case: c,
        // transcripts are large and only needed for debugging; the timeline shows tokens and outcome
        runs: runs.map(({ transcriptJson: _t, ...r }) => r),
        toolCalls: calls.map(({ handlesJson: _h, ...t }) => t),
        proposals: props,
        decisions: decs,
        executions: execs,
      };
    },

    async markDelivered(paypalOrderId, daysAgo) {
      const rows = await db
        .update(orders)
        .set({ deliveredAt: sql`now() - make_interval(days => ${daysAgo})` })
        .where(eq(orders.paypalOrderId, paypalOrderId))
        .returning({ id: orders.id });
      return rows.length > 0;
    },
  };
}
