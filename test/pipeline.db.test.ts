// Whole-pipeline tests on real Postgres: case -> scripted model -> policy engine -> executor -> fake PayPal.
// Opt-in: COUNTERSIGN_DB_TEST=1 npx vitest run test/pipeline.db.test.ts   (throw-away schema, see helpers/tempSchema.ts)
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentModel, Block, ModelResponse } from "../src/agent/agent.js";
import { type PipelineDeps, processCase } from "../src/agent/pipeline.js";
import { createCaseRepo } from "../src/db/cases.js";
import type { Db } from "../src/db/client.js";
import { agentRuns, approvals, cases, decisions, executions, policies, proposals, refundLedger, toolCalls } from "../src/db/schema.js";
import { PayPalError } from "../src/paypal/client.js";
import { dbTestsEnabled, lit, setupTempSchema } from "./helpers/tempSchema.js";

const rule = (id: string, effect: string, remedy: string, when: object, amount?: object) => ({ id, effect, remedy, when, ...(amount ? { amount } : {}) });
const BASE_RULES = [
  rule("R1", "allow", "partial_tier_b", { claim_type_in: ["damaged"], days_since_delivery_lte: 30 }, { percent_of_capture: 50 }),
  rule("R2", "deny", "partial_tier_b", { days_since_delivery_gte: 90 }),
  rule("R3", "allow", "explain_no_refund", { claim_type_in: ["changed_mind"] }),
];
const MSG = "My mug arrived in three pieces. Please refund me.";

const use = (name: string, input: unknown): Block => ({ type: "tool_use", id: `u_${Math.random().toString(36).slice(2, 8)}`, name, input });
const turn = (content: Block[], stopReason = "tool_use"): ModelResponse => ({ content, stopReason, usage: { input: 100, output: 20 } });
const propose = (over: Record<string, unknown> = {}) =>
  use("propose_remedy", { claim_type: "damaged", remedy: "partial_tier_b", capture_handle: "h_2", buyer_message_draft: "So sorry, we are on it.", rationale: "broken on arrival", cited_tool_calls: ["tc_1", "tc_2"], ...over });
const investigate = () => [turn([use("get_order", {})]), turn([use("get_capture", { handle: "h_1" })])];

describe.skipIf(!dbTestsEnabled)("case pipeline on real Postgres", { timeout: 180_000 }, () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let client: Awaited<ReturnType<typeof setupTempSchema>>["client"];
  let version = 0;

  beforeAll(async () => {
    const t = await setupTempSchema();
    ({ db, teardown, client } = t);
  }, 120_000);
  afterAll(async () => { await teardown?.(); });

  beforeEach(async () => {
    await db.execute(sql`truncate approvals, refund_ledger, executions, decisions, proposals, tool_calls, agent_runs, cases, orders cascade`);
  });

  async function activate(rules: unknown[] = BASE_RULES, limits: object = { daily_auto_refund_cap_minor: 10_000 }) {
    await db.update(policies).set({ status: "retired" }).where(eq(policies.status, "active"));
    const id = randomUUID();
    await db.insert(policies).values({ id, version: ++version, sourceText: "t", rulesJson: { currency: "USD", rules, limits }, rulesHash: "h", testCasesJson: {}, status: "active" });
    return id;
  }

  async function seedOrder(o: { delivered?: number | null; payer?: string | null; amount?: number } = {}) {
    const paypalOrderId = `PP-${randomUUID().slice(0, 8)}`;
    const delivered = o.delivered === undefined ? 10 : o.delivered;
    await client.unsafe(
      `insert into orders (id, paypal_order_id, capture_id, payer_id, amount_minor, currency, delivered_at) values (${lit(randomUUID())}, ${lit(paypalOrderId)}, ${lit(`CAP-${randomUUID()}`)}, ${lit(o.payer === undefined ? "payer-1" : o.payer)}, ${o.amount ?? 3800}, 'USD', ${delivered === null ? "null" : `now() - interval '${delivered} days'`});`,
    );
    return paypalOrderId;
  }

  async function openCase(paypalOrderId: string) {
    const r = await createCaseRepo(db).open(paypalOrderId, MSG);
    if (!r.ok) throw new Error(`could not open case: ${r.error}`);
    return r.caseId;
  }

  function scripted(...responses: ModelResponse[]) {
    const calls = { n: 0 };
    const model: AgentModel = async () => {
      const r = responses[Math.min(calls.n, responses.length - 1)];
      calls.n++;
      if (!r) throw new Error("no scripted response");
      return r;
    };
    return { model, calls };
  }

  function fakePaypal(mode: "ok" | "timeout" | "reject" = "ok") {
    const calls: { requestId: string; amountMinor: number; captureId: string }[] = [];
    return {
      calls,
      async refundCapture(p: { captureId: string; amountMinor: number; currency: string; requestId: string }) {
        calls.push(p);
        if (mode === "timeout") throw new Error("socket hang up");
        if (mode === "reject") throw new PayPalError(422, {}, "dbg");
        return { id: `REF-${calls.length}`, status: "COMPLETED", replayed: false };
      },
    };
  }

  const deps = (model: AgentModel, paypal: ReturnType<typeof fakePaypal>): PipelineDeps => ({ db, model, paypal });
  const caseRow = async (id: string) => (await db.select().from(cases).where(eq(cases.id, id)))[0];

  it("claim -> agent -> engine -> executor -> refund: records every step", async () => {
    const policyId = await activate();
    const caseId = await openCase(await seedOrder());
    const pp = fakePaypal();
    const s = scripted(...investigate(), turn([propose()]));
    const r = await processCase(deps(s.model, pp), caseId);

    expect(r).toMatchObject({ status: "resolved" });
    expect(pp.calls).toHaveLength(1);
    expect(pp.calls[0]).toMatchObject({ amountMinor: 1900 }); // 50% of $38, decided by code
    const c = await caseRow(caseId);
    expect(c).toMatchObject({ status: "resolved" });
    expect(c?.outcomeReason).toMatch(/refunded \$19\.00 \(REF-1\)/);

    const [run] = await db.select().from(agentRuns);
    expect(run).toMatchObject({ caseId, outcome: "proposal", tokensIn: 300, tokensOut: 60 });
    expect(await db.select().from(toolCalls)).toHaveLength(2);
    const [prop] = await db.select().from(proposals);
    expect(prop).toMatchObject({ remedy: "partial_tier_b", captureHandle: "h_2" });
    const [dec] = await db.select().from(decisions);
    expect(dec).toMatchObject({ decision: "ALLOW", amountMinor: 1900, ruleIds: ["R1"], policyId });
    const [ex] = await db.select().from(executions);
    expect(ex).toMatchObject({ status: "SUCCEEDED", decisionId: dec?.id, idempotencyKey: `refund-${dec?.id}` });
    expect((await db.select().from(refundLedger))[0]).toMatchObject({ status: "completed", amountMinor: 1900, paypalRefundId: "REF-1" });
  });

  it("a model that overreaches (proposes a tier no rule allows) cannot move money: it goes to approval", async () => {
    await activate();
    const caseId = await openCase(await seedOrder());
    const pp = fakePaypal();
    const r = await processCase(deps(scripted(...investigate(), turn([propose({ remedy: "full_refund" })])).model, pp), caseId);
    expect(r.status).toBe("needs_approval");
    expect(pp.calls).toHaveLength(0);
    expect(await db.select().from(refundLedger)).toHaveLength(0);
    expect((await db.select().from(decisions))[0]).toMatchObject({ decision: "REQUIRE_APPROVAL", ruleIds: ["SYS_NO_MATCH"] });
    const [ap] = await db.select().from(approvals);
    expect(ap).toMatchObject({ status: "pending", amountMinor: null }); // no rule matched: the reviewer must supply the amount
    expect(ap?.paramsHash).toHaveLength(64);
    expect(ap?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
  });

  it("a cap that downgrades an ALLOW creates an approval carrying the engine's suggested amount", async () => {
    await activate(BASE_RULES, { daily_auto_refund_cap_minor: 1000 }); // 50% of $38 = $19 > $10 cap
    const pp = fakePaypal();
    const r = await processCase(deps(scripted(...investigate(), turn([propose()])).model, pp), await openCase(await seedOrder()));
    expect(r.status).toBe("needs_approval");
    expect(r.reason).toMatch(/LIMIT_DAILY/);
    expect(pp.calls).toHaveLength(0);
    expect((await db.select().from(approvals))[0]).toMatchObject({ status: "pending", amountMinor: 1900 });
  });

  it("denied and escalated cases create no approval; a no-money remedy that needs approval goes straight to a human", async () => {
    await activate([...BASE_RULES, rule("R4", "require_approval", "replacement_offer", {})]);
    await processCase(deps(scripted(...investigate(), turn([propose()])).model, fakePaypal()), await openCase(await seedOrder({ delivered: 120 })));
    const r = await processCase(deps(scripted(...investigate(), turn([propose({ remedy: "replacement_offer" })])).model, fakePaypal()), await openCase(await seedOrder()));
    expect(r.status).toBe("NEEDS_HUMAN");
    expect(r.reason).toMatch(/handle this one manually/);
    expect(await db.select().from(approvals)).toHaveLength(0);
  });

  it("outside the policy window the engine, not the model, says no to auto-refund", async () => {
    await activate();
    const pp = fakePaypal();
    const r = await processCase(deps(scripted(...investigate(), turn([propose()])).model, pp), await openCase(await seedOrder({ delivered: 40 })));
    expect(r.status).toBe("needs_approval");
    expect(pp.calls).toHaveLength(0);
  });

  it("a deny rule wins and no PayPal call is made", async () => {
    await activate();
    const pp = fakePaypal();
    const r = await processCase(deps(scripted(...investigate(), turn([propose()])).model, pp), await openCase(await seedOrder({ delivered: 120 })));
    expect(r).toMatchObject({ status: "denied" });
    expect(r.reason).toMatch(/R2/);
    expect(pp.calls).toHaveLength(0);
  });

  it("an unknown delivery date fails closed", async () => {
    await activate();
    const pp = fakePaypal();
    const r = await processCase(deps(scripted(...investigate(), turn([propose()])).model, pp), await openCase(await seedOrder({ delivered: null })));
    expect(r.status).toBe("needs_approval");
    expect(pp.calls).toHaveLength(0);
  });

  it("a remedy that moves no money can resolve without the executor", async () => {
    await activate();
    const pp = fakePaypal();
    const r = await processCase(deps(scripted(...investigate(), turn([propose({ claim_type: "changed_mind", remedy: "explain_no_refund" })])).model, pp), await openCase(await seedOrder()));
    expect(r.status).toBe("resolved");
    expect(pp.calls).toHaveLength(0);
    expect(await db.select().from(executions)).toHaveLength(0);
  });

  it("an escalation goes to a human", async () => {
    await activate();
    const r = await processCase(deps(scripted(...investigate(), turn([propose({ remedy: "escalate" })])).model, fakePaypal()), await openCase(await seedOrder()));
    expect(r).toMatchObject({ status: "NEEDS_HUMAN", reason: "agent escalated" });
  });

  it("with no active policy nothing is attempted: the model is never even called", async () => {
    await db.update(policies).set({ status: "retired" });
    const s = scripted(...investigate());
    const r = await processCase(deps(s.model, fakePaypal()), await openCase(await seedOrder()));
    expect(r).toMatchObject({ status: "NEEDS_HUMAN" });
    expect(r.reason).toMatch(/no active policy/);
    expect(s.calls.n).toBe(0);
  });

  it("an invalid or fabricated proposal ends in NEEDS_HUMAN with no decision and no money", async () => {
    await activate();
    const pp = fakePaypal();
    const bad = propose({ capture_handle: "CAP-FABRICATED-123" });
    const r = await processCase(deps(scripted(...investigate(), turn([bad])).model, pp), await openCase(await seedOrder()));
    expect(r).toMatchObject({ status: "NEEDS_HUMAN", reason: "agent: invalid_proposal" });
    expect(await db.select().from(decisions)).toHaveLength(0);
    expect(pp.calls).toHaveLength(0);
    expect((await db.select().from(agentRuns))[0]?.outcome).toBe("needs_human:invalid_proposal");
  });

  it("PayPal timing out leaves the money reserved and the case with a human; a 422 releases it", async () => {
    await activate();
    const timeout = fakePaypal("timeout");
    const a = await processCase(deps(scripted(...investigate(), turn([propose()])).model, timeout), await openCase(await seedOrder()));
    expect(a.status).toBe("NEEDS_HUMAN");
    expect((await db.select().from(refundLedger))[0]).toMatchObject({ status: "reserved" });

    await db.execute(sql`truncate approvals, refund_ledger, executions, decisions, proposals, tool_calls, agent_runs, cases, orders cascade`);
    const reject = fakePaypal("reject");
    const b = await processCase(deps(scripted(...investigate(), turn([propose()])).model, reject), await openCase(await seedOrder()));
    expect(b.status).toBe("NEEDS_HUMAN");
    expect(b.reason).toMatch(/422/);
    expect((await db.select().from(refundLedger))[0]).toMatchObject({ status: "failed" });
  });

  it("a crashing model leaves the case in 'error', never stuck in 'processing'", async () => {
    await activate();
    const model: AgentModel = async () => { throw new Error("anthropic is down"); };
    const caseId = await openCase(await seedOrder());
    expect((await processCase(deps(model, fakePaypal()), caseId)).status).toBe("error");
    expect((await caseRow(caseId))?.status).toBe("error");
  });

  it("two workers on the same case: exactly one runs it", async () => {
    await activate();
    const caseId = await openCase(await seedOrder());
    const pp = fakePaypal();
    const s = scripted(...investigate(), turn([propose()]));
    const [a, b] = await Promise.all([processCase(deps(s.model, pp), caseId), processCase(deps(s.model, pp), caseId)]);
    expect([a.status, b.status].sort()).toEqual(["resolved", "skipped"]);
    expect(pp.calls).toHaveLength(1);
    expect(await db.select().from(agentRuns)).toHaveLength(1);
  });

  it("the database allows one live case per order, and a new one once the first is finished", async () => {
    await activate();
    const paypalOrderId = await seedOrder();
    const repo = createCaseRepo(db);
    const first = await repo.open(paypalOrderId, MSG);
    expect(first.ok).toBe(true);
    expect(await repo.open(paypalOrderId, MSG)).toEqual({ ok: false, error: "duplicate_active" });
    if (first.ok) await db.update(cases).set({ status: "resolved" }).where(eq(cases.id, first.caseId));
    expect((await repo.open(paypalOrderId, MSG)).ok).toBe(true);
    expect(await repo.open("PP-NOPE", MSG)).toEqual({ ok: false, error: "unknown_order" });
  });

  it("the database refuses an invalid case status", async () => {
    const caseId = await openCase(await seedOrder());
    await expect(db.update(cases).set({ status: "approved-ish" }).where(eq(cases.id, caseId))).rejects.toThrow();
  });

  it("the admin timeline returns every step for a finished case", async () => {
    await activate();
    const caseId = await openCase(await seedOrder());
    await processCase(deps(scripted(...investigate(), turn([propose()])).model, fakePaypal()), caseId);
    const t = (await createCaseRepo(db).timeline(caseId)) as Record<string, unknown[] | object>;
    expect(Object.keys(t).sort()).toEqual(["case", "decisions", "executions", "proposals", "runs", "toolCalls"]);
    expect((t.toolCalls as unknown[]).length).toBe(2);
    expect((t.executions as unknown[]).length).toBe(1);
  });
});
