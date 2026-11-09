// Approvals (I6) and the sweeper on real Postgres. Opt-in: COUNTERSIGN_DB_TEST=1 npx vitest run test/approvals.db.test.ts
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentModel, Block, ModelResponse } from "../src/agent/agent.js";
import { createApprovalRepo } from "../src/db/approvals.js";
import type { Db } from "../src/db/client.js";
import { approvals, cases, executions, policies, refundLedger } from "../src/db/schema.js";
import { approvalParamsHash } from "../src/exec/approved.js";
import { runApproved } from "../src/exec/outcome.js";
import { runSweep } from "../src/jobs/sweeper.js";
import { PayPalError } from "../src/paypal/client.js";
import { dbTestsEnabled, lit, setupTempSchema } from "./helpers/tempSchema.js";

const POLICY_ID = "policy-1";
const POLHASH = "polhash-v1";
const POLICY = {
  currency: "USD",
  rules: [
    { id: "R1", effect: "allow", remedy: "partial_tier_b", when: { claim_type_in: ["damaged"], days_since_delivery_lte: 30 }, amount: { percent_of_capture: 50 } },
    { id: "R2", effect: "deny", remedy: "partial_tier_b", when: { days_since_delivery_gte: 90 } },
  ],
  limits: { daily_auto_refund_cap_minor: 10_000 },
};

describe.skipIf(!dbTestsEnabled)("approvals and sweeper on real Postgres", { timeout: 180_000 }, () => {
  let db: Db;
  let client: Awaited<ReturnType<typeof setupTempSchema>>["client"];
  let teardown: () => Promise<void>;
  const repo = () => createApprovalRepo(db);

  beforeAll(async () => {
    ({ db, client, teardown } = await setupTempSchema());
    await db.insert(policies).values({ id: POLICY_ID, version: 1, sourceText: "t", rulesJson: POLICY, rulesHash: POLHASH, testCasesJson: {}, status: "active" });
  }, 120_000);
  afterAll(async () => { await teardown?.(); });

  beforeEach(async () => {
    await db.execute(sql`truncate approvals, refund_ledger, executions, decisions, proposals, tool_calls, agent_runs, cases, orders cascade`);
    await db.delete(policies).where(sql`${policies.id} <> ${POLICY_ID}`);
    await db.update(policies).set({ status: "active", rulesJson: POLICY, rulesHash: POLHASH }).where(eq(policies.id, POLICY_ID));
  });

  type Seed = { suggested?: number | null; status?: string; amount?: number; expiresInSec?: number; delivered?: number; orderAmount?: number; caseStatus?: string; decidedAgoSec?: number };
  async function seedApproval(o: Seed = {}) {
    const orderId = randomUUID(), caseId = randomUUID(), runId = randomUUID(), proposalId = randomUUID(), decisionId = randomUUID(), approvalId = randomUUID();
    const paypalOrderId = `PP-${randomUUID().slice(0, 8)}`, captureId = `CAP-${randomUUID()}`;
    const suggested = o.suggested === undefined ? 1900 : o.suggested;
    const status = o.status ?? "pending";
    const amount = status === "pending" ? suggested : (o.amount ?? suggested);
    const paramsHash = approvalParamsHash({ decisionId, orderId, remedy: "partial_tier_b", amountMinor: amount });
    await client.unsafe(
      `insert into orders (id, paypal_order_id, capture_id, payer_id, amount_minor, currency, delivered_at) values (${lit(orderId)}, ${lit(paypalOrderId)}, ${lit(captureId)}, 'payer-1', ${o.orderAmount ?? 3800}, 'USD', now() - interval '${o.delivered ?? 10} days');` +
        `insert into cases (id, source, order_id, status, buyer_message) values (${lit(caseId)}, 'form', ${lit(orderId)}, ${lit(o.caseStatus ?? "needs_approval")}, 'my mug broke');` +
        `insert into agent_runs (id, case_id, model, transcript_json) values (${lit(runId)}, ${lit(caseId)}, 'test', '[]'::jsonb);` +
        `insert into proposals (id, case_id, run_id, claim_type, remedy, capture_handle, params_hash, message_draft) values (${lit(proposalId)}, ${lit(caseId)}, ${lit(runId)}, 'damaged', 'partial_tier_b', 'h_2', 'p', 'sorry!');` +
        `insert into decisions (id, proposal_id, policy_id, decision, amount_minor, rule_ids, context_json) values (${lit(decisionId)}, ${lit(proposalId)}, ${lit(POLICY_ID)}, 'REQUIRE_APPROVAL', ${suggested === null ? "null" : suggested}, '["SYS_NO_MATCH"]'::jsonb, '{"reasons":["no rule matched"]}'::jsonb);` +
        `insert into approvals (id, decision_id, params_hash, policy_hash, amount_minor, expires_at, status, decided_at) values (${lit(approvalId)}, ${lit(decisionId)}, ${lit(paramsHash)}, ${lit(POLHASH)}, ${amount === null ? "null" : amount}, now() + interval '${o.expiresInSec ?? 3600} seconds', ${lit(status)}, ${status === "pending" ? "null" : `now() - interval '${o.decidedAgoSec ?? 0} seconds'`});`,
    );
    return { approvalId, decisionId, caseId, orderId, paypalOrderId, captureId, paramsHash };
  }

  function fakePaypal(mode: () => "ok" | "timeout" | "reject" = () => "ok") {
    const calls: { requestId: string; amountMinor: number; captureId: string }[] = [];
    const created = new Map<string, string>(); // like PayPal: the same PayPal-Request-Id returns the same refund
    return {
      calls,
      async refundCapture(p: { captureId: string; amountMinor: number; currency: string; requestId: string }) {
        calls.push(p);
        const m = mode();
        if (m === "timeout") throw new Error("socket hang up");
        if (m === "reject") throw new PayPalError(422, {}, "dbg");
        const existing = created.get(p.requestId);
        const id = existing ?? `REF-${created.size + 1}`;
        created.set(p.requestId, id);
        return { id, status: "COMPLETED", replayed: existing !== undefined };
      },
    };
  }

  const approvalRow = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0];
  const caseRow = async (id: string) => (await db.select().from(cases).where(eq(cases.id, id)))[0];
  const run = (pp: ReturnType<typeof fakePaypal>, id: string) => runApproved({ db, paypal: pp, approvals: repo() }, id);

  describe("approving and rejecting", () => {
    it("lists the inbox with everything a reviewer needs, one approval per decision", async () => {
      const s = await seedApproval();
      const [v] = await repo().list("pending");
      expect(v).toMatchObject({ id: s.approvalId, caseId: s.caseId, paypalOrderId: s.paypalOrderId, orderTotalMinor: 3800, remedy: "partial_tier_b", claimType: "damaged", suggestedAmountMinor: 1900, buyerMessage: "my mug broke", agentDraft: "sorry!", reasons: ["no rule matched"] });
      expect(v?.paramsHash).toBe(s.paramsHash);
      expect(await repo().create({ decisionId: s.decisionId, orderId: s.orderId, remedy: "partial_tier_b", amountMinor: 1900, policyHash: POLHASH, expiresAt: new Date(Date.now() + 1e6) })).toBeNull();
    });

    it("approve: the reviewer echoes the hash; the approved amount is bound into a NEW hash", async () => {
      const s = await seedApproval();
      const r = await repo().approve(s.approvalId, { paramsHash: s.paramsHash });
      expect(r).toEqual({ ok: true, amountMinor: 1900 });
      const row = await approvalRow(s.approvalId);
      expect(row).toMatchObject({ status: "approved", amountMinor: 1900 });
      expect(row?.paramsHash).toBe(approvalParamsHash({ decisionId: s.decisionId, orderId: s.orderId, remedy: "partial_tier_b", amountMinor: 1900 }));
    });

    it("the reviewer can lower the amount, which changes the hash; more than the refundable balance is refused", async () => {
      const a = await seedApproval();
      expect(await repo().approve(a.approvalId, { paramsHash: a.paramsHash, amountMinor: 1000 })).toEqual({ ok: true, amountMinor: 1000 });
      expect((await approvalRow(a.approvalId))?.paramsHash).not.toBe(a.paramsHash);
      const b = await seedApproval();
      expect(await repo().approve(b.approvalId, { paramsHash: b.paramsHash, amountMinor: 3801 })).toEqual({ ok: false, error: "exceeds_refundable" });
      expect((await approvalRow(b.approvalId))?.status).toBe("pending");
    });

    it("a case with no engine suggestion needs the reviewer to supply an amount", async () => {
      const s = await seedApproval({ suggested: null });
      expect(await repo().approve(s.approvalId, { paramsHash: s.paramsHash })).toEqual({ ok: false, error: "amount_required" });
      expect(await repo().approve(s.approvalId, { paramsHash: s.paramsHash, amountMinor: 1500 })).toEqual({ ok: true, amountMinor: 1500 });
    });

    it("refuses a wrong or stale hash, an expired approval, and one already decided", async () => {
      const s = await seedApproval();
      expect(await repo().approve(s.approvalId, { paramsHash: "0".repeat(64) })).toEqual({ ok: false, error: "hash_mismatch" });
      expect(await repo().approve("nope", { paramsHash: s.paramsHash })).toEqual({ ok: false, error: "not_found" });
      const late = await seedApproval({ expiresInSec: -5 });
      expect(await repo().approve(late.approvalId, { paramsHash: late.paramsHash })).toEqual({ ok: false, error: "expired" });
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash });
      expect(await repo().approve(s.approvalId, { paramsHash: s.paramsHash })).toEqual({ ok: false, error: "not_pending" });
    });

    it("two simultaneous approve clicks: exactly one wins", async () => {
      const s = await seedApproval();
      const results = await Promise.all([repo().approve(s.approvalId, { paramsHash: s.paramsHash }), repo().approve(s.approvalId, { paramsHash: s.paramsHash })]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.error === "not_pending")).toHaveLength(1);
    });

    it("reject denies the case and cannot be repeated", async () => {
      const s = await seedApproval();
      expect(await repo().reject(s.approvalId, "0".repeat(64))).toEqual({ ok: false, error: "hash_mismatch" });
      expect(await repo().reject(s.approvalId, s.paramsHash)).toEqual({ ok: true });
      expect(await caseRow(s.caseId)).toMatchObject({ status: "denied", outcomeReason: "rejected by the merchant" });
      expect(await repo().reject(s.approvalId, s.paramsHash)).toEqual({ ok: false, error: "not_pending" });
    });

    it("the database refuses an approved approval without an amount", async () => {
      const s = await seedApproval();
      await expect(db.update(approvals).set({ status: "approved", amountMinor: null }).where(eq(approvals.id, s.approvalId))).rejects.toThrow();
      await expect(db.update(approvals).set({ status: "maybe" }).where(eq(approvals.id, s.approvalId))).rejects.toThrow();
    });
  });

  describe("executing an approved refund (I6)", () => {
    it("approve then run: refunds exactly the approved amount, uses the approval once, resolves the case", async () => {
      const s = await seedApproval();
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash, amountMinor: 1500 });
      const pp = fakePaypal();
      const out = await run(pp, s.approvalId);
      expect(out).toMatchObject({ status: "resolved" });
      expect(pp.calls).toHaveLength(1);
      expect(pp.calls[0]).toMatchObject({ amountMinor: 1500, requestId: `refund-${s.decisionId}`, captureId: s.captureId });
      expect(await approvalRow(s.approvalId)).toMatchObject({ status: "used" });
      expect((await approvalRow(s.approvalId))?.usedAt).not.toBeNull();
      expect((await db.select().from(refundLedger))[0]).toMatchObject({ status: "completed", amountMinor: 1500, origin: "countersign" });
      expect(await caseRow(s.caseId)).toMatchObject({ status: "resolved" });
    });

    it("single use: two simultaneous executions of one approval reserve once and share ONE idempotency key", async () => {
      const s = await seedApproval();
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash });
      const pp = fakePaypal();
      const [a, b] = await Promise.all([run(pp, s.approvalId), run(pp, s.approvalId)]);
      expect(new Set(pp.calls.map((c) => c.requestId))).toEqual(new Set([`refund-${s.decisionId}`])); // PayPal replays the same key instead of refunding twice
      expect(await db.select().from(executions)).toHaveLength(1);
      const ledger = await db.select().from(refundLedger);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ status: "completed", amountMinor: 1900 });
      expect([a.status, b.status]).toEqual(["resolved", "resolved"]);
    });

    it("a pending (never approved) approval cannot be executed", async () => {
      const s = await seedApproval();
      const pp = fakePaypal();
      const out = await run(pp, s.approvalId);
      expect(out.result).toMatchObject({ outcome: "not_allowed", reason: "approval_pending" });
      expect(pp.calls).toHaveLength(0);
    });

    it("a policy activated after the approval invalidates it", async () => {
      const s = await seedApproval();
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash });
      await db.update(policies).set({ status: "retired" }).where(eq(policies.id, POLICY_ID));
      await db.insert(policies).values({ id: "policy-2", version: 2, sourceText: "t", rulesJson: POLICY, rulesHash: "polhash-v2", testCasesJson: {}, status: "active" });
      const pp = fakePaypal();
      const out = await run(pp, s.approvalId);
      expect(out.result).toMatchObject({ outcome: "not_allowed", reason: "policy_changed" });
      expect(pp.calls).toHaveLength(0);
      expect((await approvalRow(s.approvalId))?.status).toBe("rejected");
      expect(await caseRow(s.caseId)).toMatchObject({ status: "NEEDS_HUMAN" });
    });

    it("an amount edited in the database after approval no longer matches its hash", async () => {
      const s = await seedApproval();
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash });
      await db.update(approvals).set({ amountMinor: 3000 }).where(eq(approvals.id, s.approvalId));
      const pp = fakePaypal();
      expect((await run(pp, s.approvalId)).result).toMatchObject({ reason: "approval_tampered" });
      expect(pp.calls).toHaveLength(0);
    });

    it("an approval that expires before execution is dead", async () => {
      const s = await seedApproval();
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash });
      await db.update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, s.approvalId));
      const pp = fakePaypal();
      expect((await run(pp, s.approvalId)).result).toMatchObject({ reason: "approval_expired" });
      expect((await approvalRow(s.approvalId))?.status).toBe("expired");
      expect(pp.calls).toHaveLength(0);
    });

    it("a human cannot override a DENY that appeared after the decision", async () => {
      const s = await seedApproval();
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash });
      await db.update(policies).set({ rulesJson: { ...POLICY, rules: [{ id: "R9", effect: "deny", remedy: "partial_tier_b", when: {} }] } }).where(eq(policies.id, POLICY_ID)); // same hash, new rules
      const pp = fakePaypal();
      expect((await run(pp, s.approvalId)).result).toMatchObject({ reason: "now_denied_by_policy" });
      expect(pp.calls).toHaveLength(0);
    });

    it("the balance can shrink between approval and execution; the executor re-checks (I5)", async () => {
      const s = await seedApproval();
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash }); // $19.00 of $38.00
      await db.insert(refundLedger).values({ id: randomUUID(), captureId: s.captureId, amountMinor: 3500, currency: "USD", paypalRefundId: "OTHER-1", origin: "external", status: "completed" });
      const pp = fakePaypal();
      expect((await run(pp, s.approvalId)).result).toMatchObject({ reason: "exceeds_refundable_balance" });
      expect(pp.calls).toHaveLength(0);
    });

    it("a human-approved refund may exceed the DAILY auto cap (that is what approval is for) but is still counted in it", async () => {
      const s = await seedApproval();
      await db.insert(refundLedger).values({ id: randomUUID(), captureId: "SEED", amountMinor: 9900, currency: "USD", paypalRefundId: "SEED-1", origin: "countersign", status: "completed" });
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash });
      const pp = fakePaypal();
      expect((await run(pp, s.approvalId)).status).toBe("resolved");
      expect((await db.select().from(refundLedger)).reduce((n, r) => n + r.amountMinor, 0)).toBe(9900 + 1900);
    });

    it("PayPal timeout after approval: approval is spent, money stays reserved, and the sweeper finishes it", async () => {
      const s = await seedApproval();
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash });
      const out = await run(fakePaypal(() => "timeout"), s.approvalId);
      expect(out).toMatchObject({ status: "NEEDS_HUMAN" });
      expect((await db.select().from(refundLedger))[0]).toMatchObject({ status: "reserved" });
      expect((await approvalRow(s.approvalId))?.status).toBe("used");

      const pp = fakePaypal();
      const report = await runSweep({ db, paypal: pp, approvals: repo(), now: () => new Date(Date.now() + 600_000) });
      expect(report.executionsResumed).toBe(1);
      expect(pp.calls[0]?.requestId).toBe(`refund-${s.decisionId}`); // same key as the failed attempt
      expect((await db.select().from(refundLedger))[0]).toMatchObject({ status: "completed" });
      expect(await caseRow(s.caseId)).toMatchObject({ status: "resolved" });
    });
  });

  describe("sweeper", () => {
    const use = (name: string, input: unknown): Block => ({ type: "tool_use", id: `u_${Math.random().toString(36).slice(2, 8)}`, name, input });
    const turn = (content: Block[]): ModelResponse => ({ content, stopReason: "tool_use", usage: { input: 1, output: 1 } });
    const script = (): { model: AgentModel; calls: { n: number } } => {
      const steps = [
        turn([use("get_order", {})]),
        turn([use("get_capture", { handle: "h_1" })]),
        turn([use("propose_remedy", { claim_type: "damaged", remedy: "partial_tier_b", capture_handle: "h_2", buyer_message_draft: "Sorry!", rationale: "r", cited_tool_calls: ["tc_1", "tc_2"] })]),
      ];
      const calls = { n: 0 };
      return { calls, model: async () => { const r = steps[Math.min(calls.n, steps.length - 1)]; calls.n++; return r as ModelResponse; } };
    };
    const later = (ms: number) => () => new Date(Date.now() + ms);

    it("starts a case that was accepted but never processed, and leaves a fresh one alone", async () => {
      const s = await seedApproval({ caseStatus: "open" });
      await db.delete(approvals); // keep only the order/case
      await db.execute(sql`delete from decisions; delete from proposals; delete from agent_runs`);
      await db.update(policies).set({ status: "active" }).where(eq(policies.id, POLICY_ID));
      const m = script();
      const fresh = await runSweep({ db, paypal: fakePaypal(), approvals: repo(), model: m.model });
      expect(fresh.casesStarted).toBe(0); // created seconds ago
      const stale = await runSweep({ db, paypal: fakePaypal(), approvals: repo(), model: m.model, now: later(120_000) });
      expect(stale.casesStarted).toBe(1);
      expect((await caseRow(s.caseId))?.status).toBe("resolved");
    });

    it("marks a case stuck in processing as error, but not one with money in flight", async () => {
      const a = await seedApproval({ caseStatus: "processing" });
      const b = await seedApproval({ caseStatus: "processing" });
      await db.insert(executions).values({ id: randomUUID(), decisionId: b.decisionId, idempotencyKey: `refund-${b.decisionId}`, requestJson: { captureId: b.captureId, amountMinor: 1900, currency: "USD" }, status: "UNKNOWN" });
      const pp = fakePaypal(() => "timeout"); // keep b unresolved so we only test the stalled rule
      const report = await runSweep({ db, paypal: pp, approvals: repo(), now: later(3_600_000), resumeAfterMs: 10 ** 12 });
      expect(report.casesStalled).toBe(1);
      expect((await caseRow(a.caseId))?.status).toBe("error");
      expect((await caseRow(b.caseId))?.status).toBe("processing");
    });

    it("expires unanswered approvals and denies their cases; running again does nothing more", async () => {
      const s = await seedApproval({ expiresInSec: 60 });
      const r1 = await runSweep({ db, paypal: fakePaypal(), approvals: repo(), now: later(3_600_000) });
      expect(r1.approvalsExpired).toBe(1);
      expect((await approvalRow(s.approvalId))?.status).toBe("expired");
      expect(await caseRow(s.caseId)).toMatchObject({ status: "denied", outcomeReason: "approval expired without a decision" });
      const r2 = await runSweep({ db, paypal: fakePaypal(), approvals: repo(), now: later(3_600_000) });
      expect(Object.values(r2).every((n) => n === 0)).toBe(true);
    });

    it("executes an approval that was granted but never run (crash after the click)", async () => {
      const s = await seedApproval();
      await repo().approve(s.approvalId, { paramsHash: s.paramsHash });
      const pp = fakePaypal();
      const early = await runSweep({ db, paypal: pp, approvals: repo() });
      expect(early.approvedExecuted).toBe(0); // decided a moment ago: someone may still be executing it
      const late = await runSweep({ db, paypal: pp, approvals: repo(), now: later(120_000) });
      expect(late.approvedExecuted).toBe(1);
      expect(pp.calls).toHaveLength(1);
      expect(await caseRow(s.caseId)).toMatchObject({ status: "resolved" });
    });
  });
});
