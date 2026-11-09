// Demo reset: wipe everything a demo run creates, keep every policy version.
// It takes the same lock as the refund executor and refuses while any refund is still in flight, so it can never
// race a payment. It is only reachable when ALLOW_DEMO_RESET=true (see routes/admin.ts).

import { inArray } from "drizzle-orm";
import { LOCK } from "../exec/executor.js";
import type { Db } from "./client.js";
import { agentRuns, approvals, auditLog, cases, decisions, executions, orders, proposals, refundLedger, toolCalls, webhookEvents } from "./schema.js";

export type ResetResult = { ok: true; deleted: Record<string, number> } | { ok: false; error: "payments_in_flight" };

export interface DemoRepo {
  reset(): Promise<ResetResult>;
}

export function createDemoRepo(db: Db): DemoRepo {
  return {
    async reset() {
      return db.transaction(async (tx) => {
        await tx.execute(LOCK);
        const [inFlight] = await tx.select({ id: executions.id }).from(executions).where(inArray(executions.status, ["PENDING", "UNKNOWN"])).limit(1);
        if (inFlight) return { ok: false, error: "payments_in_flight" } as const;

        // Child tables first, so foreign keys never block a delete.
        const deleted: Record<string, number> = {};
        const wipe = async (name: string, run: () => Promise<{ id: string }[]>) => { deleted[name] = (await run()).length; };
        await wipe("auditLog", () => tx.delete(auditLog).returning({ id: auditLog.id }));
        await wipe("approvals", () => tx.delete(approvals).returning({ id: approvals.id }));
        await wipe("executions", () => tx.delete(executions).returning({ id: executions.id }));
        await wipe("refundLedger", () => tx.delete(refundLedger).returning({ id: refundLedger.id }));
        await wipe("decisions", () => tx.delete(decisions).returning({ id: decisions.id }));
        await wipe("proposals", () => tx.delete(proposals).returning({ id: proposals.id }));
        await wipe("toolCalls", () => tx.delete(toolCalls).returning({ id: toolCalls.id }));
        await wipe("agentRuns", () => tx.delete(agentRuns).returning({ id: agentRuns.id }));
        await wipe("cases", () => tx.delete(cases).returning({ id: cases.id }));
        await wipe("orders", () => tx.delete(orders).returning({ id: orders.id }));
        await wipe("webhookEvents", () => tx.delete(webhookEvents).returning({ id: webhookEvents.id }));
        return { ok: true, deleted } as const;
      });
    },
  };
}
