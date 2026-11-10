// Demo reset and seeding on real Postgres. Opt-in: COUNTERSIGN_DB_TEST=1 npx vitest run test/demo.db.test.ts
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { createDemoRepo } from "../src/db/demo.js";
import { createPolicyRepo } from "../src/db/policies.js";
import { createOrderRepo } from "../src/db/repos.js";
import { policies } from "../src/db/schema.js";
import { seedDemoPolicy } from "../src/db/seed.js";
import { DEMO_POLICY } from "../src/policy/demoPolicy.js";
import { policyHash } from "../src/policy/hash.js";
import { Policy } from "../src/policy/schema.js";
import { dbTestsEnabled, lit, setupTempSchema } from "./helpers/tempSchema.js";

const TABLES = ["orders", "cases", "agent_runs", "tool_calls", "proposals", "decisions", "approvals", "executions", "refund_ledger", "webhook_events"] as const;

describe.skipIf(!dbTestsEnabled)("demo reset and seed on real Postgres", { timeout: 120_000 }, () => {
  let db: Db;
  let client: Awaited<ReturnType<typeof setupTempSchema>>["client"];
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, client, teardown } = await setupTempSchema()); }, 120_000);
  afterAll(async () => { await teardown?.(); });
  beforeEach(async () => {
    await db.execute(sql`truncate ${sql.raw(TABLES.join(", "))}, policies cascade`);
  });

  const count = async (t: string) => ((await client.unsafe(`select count(*)::int as n from ${t}`)) as unknown as { n: number }[])[0]?.n ?? -1;

  // One complete demo footprint: an order, a case, an agent run with a tool call, a proposal, a decision, an approval,
  // an execution, a ledger row and a webhook event.
  async function seedFootprint(executionStatus = "SUCCEEDED") {
    const [o, c, r, p, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await client.unsafe(
      `insert into policies (id, version, source_text, rules_json, rules_hash, test_cases_json, status) values ('pol-1', 1, 't', '{}'::jsonb, 'h', '{}'::jsonb, 'active') on conflict do nothing;` +
        `insert into orders (id, paypal_order_id, capture_id, payer_id, amount_minor, currency) values (${lit(o)}, ${lit(`PP-${o}`)}, ${lit(`CAP-${o}`)}, 'payer', 3800, 'USD');` +
        `insert into cases (id, source, order_id, status, buyer_message) values (${lit(c)}, 'form', ${lit(o)}, 'resolved', 'broken');` +
        `insert into agent_runs (id, case_id, model, transcript_json) values (${lit(r)}, ${lit(c)}, 'test', '[]'::jsonb);` +
        `insert into tool_calls (id, run_id, name, args_json, result_json, handles_json) values (${lit(`${r}:tc_1`)}, ${lit(r)}, 'get_order', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);` +
        `insert into proposals (id, case_id, run_id, remedy, capture_handle, params_hash, message_draft) values (${lit(p)}, ${lit(c)}, ${lit(r)}, 'partial_tier_a', 'h_2', 'p', 'm');` +
        `insert into decisions (id, proposal_id, policy_id, decision, rule_ids, context_json) values (${lit(d)}, ${lit(p)}, 'pol-1', 'ALLOW', '[]'::jsonb, '{}'::jsonb);` +
        `insert into approvals (id, decision_id, params_hash, policy_hash, amount_minor, expires_at, status) values (${lit(randomUUID())}, ${lit(d)}, 'x', 'h', 1900, now() + interval '1 day', 'used');` +
        `insert into executions (id, decision_id, idempotency_key, request_json, status) values (${lit(randomUUID())}, ${lit(d)}, ${lit(`refund-${d}`)}, '{}'::jsonb, ${lit(executionStatus)});` +
        `insert into refund_ledger (id, capture_id, amount_minor, currency, paypal_refund_id, origin, status) values (${lit(randomUUID())}, ${lit(`CAP-${o}`)}, 1900, 'USD', ${lit(`R-${o}`)}, 'countersign', 'completed');` +
        `insert into webhook_events (id, paypal_event_id, type, payload) values (${lit(randomUUID())}, ${lit(`WH-${o}`)}, 'PAYMENT.CAPTURE.REFUNDED', '{}'::jsonb);`,
    );
  }

  describe("reset", () => {
    it("removes every demo table's rows, reports what it removed, and keeps all policies", async () => {
      await seedFootprint();
      await seedFootprint();
      for (const t of TABLES) expect(await count(t), t).toBe(2);
      const r = await createDemoRepo(db).reset();
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.deleted).toMatchObject({ cases: 2, orders: 2, approvals: 2, executions: 2, refundLedger: 2, webhookEvents: 2, toolCalls: 2 });
      for (const t of TABLES) expect(await count(t), t).toBe(0);
      expect(await count("policies")).toBe(1); // every policy version survives
    });

    it("refuses, changing nothing, while a refund is still in flight (UNKNOWN or PENDING)", async () => {
      for (const status of ["UNKNOWN", "PENDING"]) {
        await db.execute(sql`truncate ${sql.raw(TABLES.join(", "))}, policies cascade`);
        await seedFootprint(status);
        expect(await createDemoRepo(db).reset()).toEqual({ ok: false, error: "payments_in_flight" });
        expect(await count("orders")).toBe(1);
        expect(await count("executions")).toBe(1);
        expect(await count("refund_ledger")).toBe(1);
      }
    });

    it("settled refunds do not block it, and resetting an empty database is harmless", async () => {
      await seedFootprint("FAILED");
      expect((await createDemoRepo(db).reset()).ok).toBe(true);
      const again = await createDemoRepo(db).reset();
      expect(again.ok).toBe(true);
      if (again.ok) expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
    });
  });

  describe("seed", () => {
    it("installs the demo policy as the active version 1 on an empty database", async () => {
      const r = await seedDemoPolicy(db);
      expect(r).toEqual({ seeded: true, version: 1 });
      const active = await createPolicyRepo(db).getActive();
      expect(active?.version).toBe(1);
      expect(active?.rulesHash).toBe(policyHash(DEMO_POLICY));
      expect(Policy.parse(active?.rulesJson)).toEqual(DEMO_POLICY);
    });

    it("is a no-op when a policy is already active, so it can never replace one", async () => {
      await db.insert(policies).values({ id: "mine", version: 7, sourceText: "mine", rulesJson: { currency: "USD", rules: [] }, rulesHash: "mine-hash", testCasesJson: {}, status: "active" });
      expect(await seedDemoPolicy(db)).toEqual({ seeded: false, reason: "a policy is already active", version: 7 });
      expect((await db.select().from(policies).where(eq(policies.id, "mine")))[0]?.rulesHash).toBe("mine-hash");
      expect(await count("policies")).toBe(1);
    });

    it("running it twice installs it once; with only a retired or draft policy it adds the next version", async () => {
      await seedDemoPolicy(db);
      expect((await seedDemoPolicy(db)).seeded).toBe(false);
      expect(await count("policies")).toBe(1);

      await db.update(policies).set({ status: "retired" });
      expect(await seedDemoPolicy(db)).toEqual({ seeded: true, version: 2 });
    });
  });

  // Without a delivery date the policy cannot check its time window, so every claim on a new order escalated.
  describe("delivery date at payment", () => {
    const deliveredAge = async (paypalOrderId: string) =>
      ((await client.unsafe(`select (now() - delivered_at) as age, delivered_at is null as missing from orders where paypal_order_id = ${lit(paypalOrderId)}`)) as unknown as { age: string | null; missing: boolean }[])[0];

    it("is set when the order is paid, and not before", async () => {
      const orders = createOrderRepo(db);
      await orders.insertOrder({ paypalOrderId: "PP-A", amountMinor: 3800, currency: "USD" });
      expect((await deliveredAge("PP-A"))?.missing).toBe(true); // created but not paid: no delivery date
      await orders.setCapture("PP-A", { captureId: "CAP-A", payerId: "payer", buyerEmail: "b@example.com" });
      const after = await deliveredAge("PP-A");
      expect(after?.missing).toBe(false);
      const ageSeconds = Number((await client.unsafe(`select extract(epoch from (now() - delivered_at))::float as s from orders where paypal_order_id = 'PP-A'`) as unknown as { s: number }[])[0]?.s);
      expect(ageSeconds).toBeGreaterThanOrEqual(0);
      expect(ageSeconds).toBeLessThan(60);
    });

    it("never overwrites a delivery date that already exists, even when the capture is repeated", async () => {
      const orders = createOrderRepo(db);
      await orders.insertOrder({ paypalOrderId: "PP-B", amountMinor: 3800, currency: "USD" });
      await client.unsafe(`update orders set delivered_at = now() - interval '40 days' where paypal_order_id = 'PP-B'`);
      await orders.setCapture("PP-B", { captureId: "CAP-B", payerId: "payer" });
      await orders.setCapture("PP-B", { captureId: "CAP-B", payerId: "payer" });
      const days = Number((await client.unsafe(`select extract(day from (now() - delivered_at))::int as d from orders where paypal_order_id = 'PP-B'`) as unknown as { d: number }[])[0]?.d);
      expect(days).toBe(40);
    });
  });
});
