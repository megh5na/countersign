// Case storage for the support form and the merchant's timeline view.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentRuns, cases, decisions, executions, orders, proposals, toolCalls } from "./schema.js";

export type OpenResult = { ok: true; caseId: string } | { ok: false; error: "unknown_order" | "not_captured" | "duplicate_active" };

export interface CaseRepo {
  open(paypalOrderId: string, message: string): Promise<OpenResult>;
  status(caseId: string): Promise<{ status: string } | undefined>;
  timeline(caseId: string): Promise<unknown | undefined>;
  markDelivered(paypalOrderId: string, daysAgo: number): Promise<boolean>;
}

const pgCode = (e: unknown): string | undefined => (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;

export function createCaseRepo(db: Db): CaseRepo {
  return {
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
      const [c] = await db.select().from(cases).where(eq(cases.id, caseId));
      if (!c) return undefined;
      const runs = await db.select().from(agentRuns).where(eq(agentRuns.caseId, caseId));
      const runIds = runs.map((r) => r.id);
      const calls = runIds.length ? await db.select().from(toolCalls).where(inArray(toolCalls.runId, runIds)) : [];
      const props = await db.select().from(proposals).where(eq(proposals.caseId, caseId));
      const propIds = props.map((p) => p.id);
      const decs = propIds.length ? await db.select().from(decisions).where(inArray(decisions.proposalId, propIds)) : [];
      const decIds = decs.map((d) => d.id);
      const execs = decIds.length ? await db.select().from(executions).where(inArray(executions.decisionId, decIds)) : [];
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
