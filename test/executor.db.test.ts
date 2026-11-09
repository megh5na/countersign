// Real-Postgres tests for the executor. Opt-in: COUNTERSIGN_DB_TEST=1 npx vitest run test/executor.db.test.ts
// Runs in a throw-away schema on DATABASE_URL (direct connection), applies the real migrations, then drops it.
// Skipped by default so `npm test` and CI stay offline.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { executions, orders, policies, refundLedger } from "../src/db/schema.js";
import { type ExecuteRequest, executeRefund } from "../src/exec/executor.js";
import { PayPalError } from "../src/paypal/client.js";
import type { Proposal } from "../src/policy/engine.js";
import { Policy } from "../src/policy/schema.js";

const enabled = process.env.COUNTERSIGN_DB_TEST === "1" && !!process.env.DATABASE_URL;

const policy = (cap = 10_000) =>
  Policy.parse({
    currency: "USD",
    rules: [{ id: "R1", effect: "allow", remedy: "partial_tier_b", when: { claim_type_in: ["damaged"], days_since_delivery_lte: 30 }, amount: { percent_of_capture: 50 } }],
    limits: { daily_auto_refund_cap_minor: cap },
  });
const damaged: Proposal = { claimType: "damaged", remedy: "partial_tier_b" };

type Mode = "ok" | "timeout_after_create" | "timeout_before_create" | "reject422";

describe.skipIf(!enabled)("executor against real Postgres", { timeout: 60_000 }, () => {
  const schemaName = `cs_test_${randomUUID().slice(0, 8)}`;
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: Db;
  let policyId: string;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL as string);
    url.hostname = url.hostname.replace("-pooler", ""); // advisory locks + search_path need a direct connection
    admin = postgres(url.toString(), { max: 1 });
    await admin.unsafe(`create schema ${schemaName}`);
    client = postgres(url.toString(), { max: 8, connection: { options: `-c search_path=${schemaName}` } }); // Neon ignores a bare search_path param
    // Safety: never run migrations unless we are provably inside the throw-away schema.
    const rows = (await client`show search_path`) as unknown as { search_path: string }[];
    if (rows[0]?.search_path !== schemaName) throw new Error(`refusing to migrate: search_path is "${rows[0]?.search_path}", expected "${schemaName}"`);
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries) {
      // Drizzle writes foreign keys as REFERENCES "public"."x"; point them at the throw-away schema instead.
      const ddl = readFileSync(`drizzle/${tag}.sql`, "utf8").replaceAll('"public".', `"${schemaName}".`);
      if (/\bpublic\b/i.test(ddl)) throw new Error(`refusing to migrate: ${tag}.sql still references public`);
      await client.unsafe(ddl); // whole file in one round trip ("-->" markers are SQL comments)
    }
    db = drizzle(client, { schema }) as unknown as Db;
    policyId = randomUUID();
    await db.insert(policies).values({ id: policyId, version: 1, sourceText: "t", rulesJson: {}, rulesHash: "h", testCasesJson: {}, status: "retired" });
  }, 120_000);

  afterAll(async () => {
    await admin?.unsafe(`drop schema if exists ${schemaName} cascade`);
    await client?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate refund_ledger, executions`);
  });

  // Seeding is one multi-statement round trip each: the DB is remote, so many small inserts made the tests crawl.
  // Values are generated here (uuids, numbers, fixed strings), never user input.
  const lit = (v: string | number | null) => (v === null ? "null" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`);
  type OrderOpts = { amountMinor?: number; payerId?: string | null; deliveredDaysAgo?: number; captured?: boolean };

  const orderSql = (id: string, o: OrderOpts) =>
    `insert into orders (id, paypal_order_id, capture_id, payer_id, amount_minor, currency, delivered_at) values (${lit(id)}, ${lit(`ORD-${randomUUID()}`)}, ${lit(
      o.captured === false ? null : `CAP-${randomUUID()}`,
    )}, ${lit(o.payerId === undefined ? "payer-1" : o.payerId)}, ${o.amountMinor ?? 3800}, 'USD', now() - interval '${o.deliveredDaysAgo ?? 10} days');`;

  const decisionSql = (orderId: string, decisionId: string) => {
    const caseId = randomUUID(), runId = randomUUID(), proposalId = randomUUID();
    return (
      `insert into cases (id, source, order_id, status, buyer_message) values (${lit(caseId)}, 'form', ${lit(orderId)}, 'resolved', 'arrived broken');` +
      `insert into agent_runs (id, case_id, model, transcript_json) values (${lit(runId)}, ${lit(caseId)}, 'test', '{}'::jsonb);` +
      `insert into proposals (id, case_id, run_id, remedy, capture_handle, params_hash, message_draft) values (${lit(proposalId)}, ${lit(caseId)}, ${lit(runId)}, 'partial_tier_b', 'h_1', 'p', 'm');` +
      `insert into decisions (id, proposal_id, policy_id, decision, rule_ids, context_json) values (${lit(decisionId)}, ${lit(proposalId)}, ${lit(policyId)}, 'ALLOW', '[]'::jsonb, '{}'::jsonb);`
    );
  };

  async function seedOrder(o: OrderOpts = {}) {
    const id = randomUUID();
    await client.unsafe(orderSql(id, o));
    return { orderId: id };
  }

  async function seedDecision(orderId: string) {
    const decisionId = randomUUID();
    await client.unsafe(decisionSql(orderId, decisionId));
    return decisionId;
  }

  async function request(o: OrderOpts = {}, p: Proposal = damaged, pol = policy()): Promise<ExecuteRequest> {
    const orderId = randomUUID(), decisionId = randomUUID();
    await client.unsafe(orderSql(orderId, o) + decisionSql(orderId, decisionId));
    return { decisionId, orderId, proposal: p, policy: pol };
  }

  function fakePaypal(mode: () => Mode = () => "ok") {
    const calls: { captureId: string; amountMinor: number; currency: string; requestId: string }[] = [];
    const created = new Map<string, string>(); // requestId -> refund id (PayPal's idempotency)
    let n = 0;
    return {
      calls,
      async refundCapture(p: (typeof calls)[number]) {
        calls.push(p);
        const m = mode();
        if (m === "timeout_before_create") throw new Error("socket hang up");
        if (m === "reject422") throw new PayPalError(422, {}, "dbg");
        const existing = created.get(p.requestId);
        const id = existing ?? `REF-${++n}-${randomUUID().slice(0, 6)}`;
        created.set(p.requestId, id);
        if (m === "timeout_after_create") throw new Error("timeout after PayPal accepted it");
        return { id, status: "COMPLETED", replayed: existing !== undefined };
      },
    };
  }

  const ledger = () => db.select().from(refundLedger);
  const execs = () => db.select().from(executions);

  it("happy path: reserves, calls PayPal once with a decision-derived key, records the refund id", async () => {
    const pp = fakePaypal();
    const req = await request();
    const r = await executeRefund({ db, paypal: pp }, req);
    expect(r).toMatchObject({ outcome: "refunded", amountMinor: 1900, replayed: false });
    expect(pp.calls).toHaveLength(1);
    expect(pp.calls[0]).toMatchObject({ amountMinor: 1900, currency: "USD", requestId: `refund-${req.decisionId}` });
    const [row] = await ledger();
    expect(row).toMatchObject({ status: "completed", amountMinor: 1900, origin: "countersign" });
    expect(row?.paypalRefundId).toBe((r as { refundId: string }).refundId);
    expect((await execs())[0]).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
  });

  it("does nothing when the engine does not say ALLOW: no PayPal call, no reservation", async () => {
    const pp = fakePaypal();
    const r = await executeRefund({ db, paypal: pp }, await request({}, { claimType: "changed_mind", remedy: "partial_tier_b" }));
    expect(r).toMatchObject({ outcome: "not_allowed", reason: "REQUIRE_APPROVAL" });
    expect(pp.calls).toHaveLength(0);
    expect(await ledger()).toHaveLength(0);
    expect(await execs()).toHaveLength(0);
  });

  it("refuses non-money remedies, uncaptured orders, and orders with no known buyer", async () => {
    const pp = fakePaypal();
    expect(await executeRefund({ db, paypal: pp }, await request({}, { claimType: "damaged", remedy: "explain_no_refund" }))).toMatchObject({ reason: "remedy_moves_no_money" });
    expect(await executeRefund({ db, paypal: pp }, await request({ captured: false }))).toMatchObject({ reason: "order_not_captured" });
    expect(await executeRefund({ db, paypal: pp }, await request({ payerId: null }))).toMatchObject({ reason: "buyer_unknown" });
    expect(pp.calls).toHaveLength(0);
  });

  it("I12: two simultaneous $30 claims with $60 of a $100 daily cap used -> exactly one refund (3 rounds)", async () => {
    for (let round = 0; round < 3; round++) {
      await db.execute(sql`truncate refund_ledger, executions`);
      await db.insert(refundLedger).values({ id: randomUUID(), captureId: "SEED", amountMinor: 6000, currency: "USD", paypalRefundId: `SEED-${round}`, origin: "countersign", status: "completed" });
      const pp = fakePaypal();
      const [a, b] = await Promise.all([request({ amountMinor: 6000, payerId: "pa" }), request({ amountMinor: 6000, payerId: "pb" })]);
      const results = await Promise.all([executeRefund({ db, paypal: pp }, a), executeRefund({ db, paypal: pp }, b)]);
      expect(results.filter((r) => r.outcome === "refunded")).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "not_allowed")).toHaveLength(1);
      expect(pp.calls).toHaveLength(1);
      const total = (await ledger()).reduce((s, r) => s + r.amountMinor, 0);
      expect(total).toBe(9000); // 6000 seeded + exactly one 3000, never 12000
    }
  });

  it("a timeout keeps the amount reserved (counts toward caps); retrying the same decision reuses the key and finishes", async () => {
    let mode: Mode = "timeout_after_create";
    const pp = fakePaypal(() => mode);
    const small = policy(3000); // room for one $19 refund, not two
    const first = await request({}, damaged, small);
    expect(await executeRefund({ db, paypal: pp }, first)).toMatchObject({ outcome: "unknown", amountMinor: 1900 });
    expect((await ledger())[0]).toMatchObject({ status: "reserved", paypalRefundId: null });

    const second = await request({}, damaged, small); // another claim, same day: reservation must block it
    expect(await executeRefund({ db, paypal: pp }, second)).toMatchObject({ outcome: "not_allowed", reason: "REQUIRE_APPROVAL" });

    mode = "ok";
    const retry = await executeRefund({ db, paypal: pp }, first); // same decisionId
    expect(retry).toMatchObject({ outcome: "refunded", replayed: true });
    expect(new Set(pp.calls.map((c) => c.requestId)).size).toBe(1); // every attempt used the SAME key
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed" });
    expect((await execs())[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
  });

  it("a request that died before PayPal saw it is also UNKNOWN, and the retry succeeds without double refund", async () => {
    let mode: Mode = "timeout_before_create";
    const pp = fakePaypal(() => mode);
    const req = await request();
    expect(await executeRefund({ db, paypal: pp }, req)).toMatchObject({ outcome: "unknown" });
    mode = "ok";
    expect(await executeRefund({ db, paypal: pp }, req)).toMatchObject({ outcome: "refunded", replayed: false });
    expect(await ledger()).toHaveLength(1);
  });

  it("a definitive PayPal rejection fails the execution and releases the reservation", async () => {
    const small = policy(3000);
    const pp = fakePaypal(() => "reject422");
    const first = await request({}, damaged, small);
    expect(await executeRefund({ db, paypal: pp }, first)).toMatchObject({ outcome: "failed", paypalStatus: 422 });
    expect((await ledger())[0]).toMatchObject({ status: "failed" });
    expect((await execs())[0]).toMatchObject({ status: "FAILED" });

    const ok = fakePaypal();
    expect(await executeRefund({ db, paypal: ok }, await request({}, damaged, small))).toMatchObject({ outcome: "refunded" }); // freed capacity
    expect(await executeRefund({ db, paypal: ok }, first)).toMatchObject({ outcome: "failed" }); // a failed decision is not silently retried
    expect(ok.calls).toHaveLength(1);
  });

  it("is idempotent per decision: executing a finished decision again makes no second PayPal call", async () => {
    const pp = fakePaypal();
    const req = await request();
    await executeRefund({ db, paypal: pp }, req);
    expect(await executeRefund({ db, paypal: pp }, req)).toMatchObject({ outcome: "refunded", replayed: true });
    expect(pp.calls).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
  });

  it("repeated claims on one capture are bounded by its balance", async () => {
    const pp = fakePaypal();
    const { orderId } = await seedOrder({ amountMinor: 3800 });
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await executeRefund({ db, paypal: pp }, { decisionId: await seedDecision(orderId), orderId, proposal: damaged, policy: policy(1_000_000) });
      outcomes.push(r.outcome === "not_allowed" ? `not_allowed:${r.decision?.decision}` : r.outcome);
    }
    expect(outcomes).toEqual(["refunded", "refunded", "not_allowed:DENY", "not_allowed:DENY"]); // 1900 + 1900 = 3800
    expect((await ledger()).reduce((s, r) => s + r.amountMinor, 0)).toBe(3800);
  });

  it("merges with a refund webhook that arrived before we recorded PayPal's answer (no double count)", async () => {
    const req = await request();
    const pp = {
      calls: 0,
      async refundCapture(p: { captureId: string }) {
        this.calls++;
        await db.insert(refundLedger).values({ id: randomUUID(), captureId: p.captureId, amountMinor: 1900, currency: "USD", paypalRefundId: "REF-WEBHOOK", origin: "external" });
        return { id: "REF-WEBHOOK", status: "COMPLETED", replayed: false };
      },
    };
    expect(await executeRefund({ db, paypal: pp }, req)).toMatchObject({ outcome: "refunded", refundId: "REF-WEBHOOK" });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "countersign", status: "completed", paypalRefundId: "REF-WEBHOOK" });
  });

  it("the database refuses impossible ledger states", async () => {
    const base = { id: randomUUID(), captureId: "C", currency: "USD", origin: "countersign" };
    await expect(db.insert(refundLedger).values({ ...base, amountMinor: 0, status: "reserved" })).rejects.toThrow();
    await expect(db.insert(refundLedger).values({ ...base, id: randomUUID(), amountMinor: 100, status: "completed" })).rejects.toThrow(); // completed needs a refund id
    await expect(db.insert(refundLedger).values({ ...base, id: randomUUID(), amountMinor: 100, status: "bogus" })).rejects.toThrow();
  });
});
