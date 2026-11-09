// The sweeper: a periodic, idempotent repair loop (replaces pg-boss; see the spec change log).
// Every job here is safe to run twice or concurrently with live traffic, because each item is claimed by an atomic
// update (cases, approvals) or goes through the idempotent executor (same key -> PayPal replays instead of repeating).
//   1. cases that never started (server died after the form was accepted)  -> run them
//   2. cases stuck "processing" with nothing in flight                      -> mark error (never silently lost)
//   3. approvals nobody answered in time                                    -> expire, deny the case
//   4. approved refunds that were never executed (crash after the click)   -> execute them
//   5. executions left PENDING/UNKNOWN (timeouts, crashes)                  -> finish them with the SAME idempotency key

import { and, eq, inArray, lt } from "drizzle-orm";
import { processCase } from "../agent/pipeline.js";
import type { AgentModel } from "../agent/agent.js";
import type { ApprovalRepo } from "../db/approvals.js";
import type { Db } from "../db/client.js";
import { approvals, cases, decisions, executions, proposals } from "../db/schema.js";
import { settle } from "../exec/executor.js";
import { describeResult, runApproved } from "../exec/outcome.js";
import type { PayPalClient } from "../paypal/client.js";

export interface SweeperDeps {
  db: Db;
  paypal: Pick<PayPalClient, "refundCapture">;
  approvals: ApprovalRepo;
  model?: AgentModel; // absent = cases are not restarted
  now?: () => Date;
  openAfterMs?: number;
  stalledAfterMs?: number;
  approvedAfterMs?: number;
  resumeAfterMs?: number;
  batch?: number;
}

export interface SweepReport {
  casesStarted: number;
  casesStalled: number;
  approvalsExpired: number;
  approvedExecuted: number;
  executionsResumed: number;
}

const caseOfDecision = async (db: Db, decisionId: string) => {
  const [row] = await db.select({ caseId: proposals.caseId }).from(decisions).innerJoin(proposals, eq(decisions.proposalId, proposals.id)).where(eq(decisions.id, decisionId));
  return row?.caseId;
};

export async function runSweep(deps: SweeperDeps): Promise<SweepReport> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const limit = deps.batch ?? 5;
  const report: SweepReport = { casesStarted: 0, casesStalled: 0, approvalsExpired: 0, approvedExecuted: 0, executionsResumed: 0 };

  // 1. Cases accepted but never picked up.
  if (deps.model) {
    const stale = await db.select({ id: cases.id }).from(cases).where(and(eq(cases.status, "open"), lt(cases.createdAt, ago(deps.openAfterMs ?? 30_000)))).limit(limit);
    for (const c of stale) {
      const r = await processCase({ db, model: deps.model, paypal: deps.paypal, now: deps.now }, c.id);
      if (r.status !== "skipped") report.casesStarted++;
    }
  }

  // 2. Stuck in "processing" with no money in flight (those are handled by step 5).
  const stuck = await db.select({ id: cases.id }).from(cases).where(and(eq(cases.status, "processing"), lt(cases.createdAt, ago(deps.stalledAfterMs ?? 600_000)))).limit(limit);
  for (const c of stuck) {
    const [inFlight] = await db
      .select({ id: executions.id })
      .from(executions)
      .innerJoin(decisions, eq(executions.decisionId, decisions.id))
      .innerJoin(proposals, eq(decisions.proposalId, proposals.id))
      .where(and(eq(proposals.caseId, c.id), inArray(executions.status, ["PENDING", "UNKNOWN"])));
    if (inFlight) continue;
    const done = await db.update(cases).set({ status: "error", outcomeReason: "stalled: the server stopped while processing this case" }).where(and(eq(cases.id, c.id), eq(cases.status, "processing"))).returning({ id: cases.id });
    report.casesStalled += done.length;
  }

  // 3. Approvals that expired unanswered (including approved-but-never-executed ones).
  const expired = await db
    .update(approvals)
    .set({ status: "expired" })
    .where(and(inArray(approvals.status, ["pending", "approved"]), lt(approvals.expiresAt, now)))
    .returning({ id: approvals.id, decisionId: approvals.decisionId });
  for (const a of expired) {
    const caseId = await caseOfDecision(db, a.decisionId);
    if (caseId) await db.update(cases).set({ status: "denied", outcomeReason: "approval expired without a decision" }).where(and(eq(cases.id, caseId), eq(cases.status, "needs_approval")));
  }
  report.approvalsExpired = expired.length;

  // 4. Approved, not yet executed (the click was recorded, then the server died).
  const waiting = await db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.status, "approved"), lt(approvals.decidedAt, ago(deps.approvedAfterMs ?? 60_000)))).limit(limit);
  for (const a of waiting) {
    await runApproved({ db, paypal: deps.paypal, approvals: deps.approvals, now: deps.now }, a.id);
    report.approvedExecuted++;
  }

  // 5. Executions that never reached an end state: finish them with the same key.
  const open = await db.select().from(executions).where(and(inArray(executions.status, ["PENDING", "UNKNOWN"]), lt(executions.createdAt, ago(deps.resumeAfterMs ?? 120_000)))).limit(limit);
  for (const e of open) {
    const result = await settle({ db, paypal: deps.paypal }, e);
    const caseId = await caseOfDecision(db, e.decisionId);
    if (caseId) {
      const o = describeResult(result, "approved");
      // Never overwrite a case a human or a later step already moved on.
      await db.update(cases).set({ status: o.status, outcomeReason: o.reason }).where(and(eq(cases.id, caseId), inArray(cases.status, ["NEEDS_HUMAN", "processing"])));
    }
    report.executionsResumed++;
  }
  return report;
}

export function startSweeper(deps: SweeperDeps, everyMs = 60_000) {
  let running = false; // never overlap with itself
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runSweep(deps);
      if (Object.values(r).some((n) => n > 0)) console.log("sweep:", JSON.stringify(r));
    } catch (e) {
      console.error("sweep failed:", e instanceof Error ? e.message : "unknown error");
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

