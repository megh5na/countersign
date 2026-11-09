import { describe, expect, it } from "vitest";
import type { ApprovalRepo, ApprovalView, ApproveResult, ManualResult, RejectResult } from "../src/db/approvals.js";
import type { CaseRepo, DeclineResult } from "../src/db/cases.js";
import { adminRoutes } from "../src/routes/admin.js";

const TOKEN = "correct-horse-battery-staple";
const HASH = "a".repeat(64);
const casesStub: CaseRepo = { list: async () => [], decline: async () => "declined", open: async () => ({ ok: false, error: "unknown_order" }), status: async () => undefined, timeline: async () => undefined, markDelivered: async () => false };
const view = (over: Partial<ApprovalView> = {}): ApprovalView => ({
  id: "ap-1", status: "pending", paramsHash: HASH, suggestedAmountMinor: 1900, expiresAt: new Date(), createdAt: new Date(), caseId: "case-1", paypalOrderId: "PP-1",
  orderTotalMinor: 3800, remedy: "partial_tier_b", claimType: "damaged", buyerMessage: "broken", agentDraft: "sorry", ruleIds: ["SYS_NO_MATCH"], reasons: [], ...over,
});

function setup(o: { approve?: ApproveResult; reject?: RejectResult; manual?: ManualResult; decline?: DeclineResult; configured?: boolean; runThrows?: boolean } = {}) {
  const manualCalls: { caseId: string; input: { remedy: string; amountMinor: number } }[] = [];
  const declined: string[] = [];
  const approveCalls: { id: string; input: { paramsHash: string; amountMinor?: number } }[] = [];
  const rejectCalls: [string, string][] = [];
  const ran: string[] = [];
  const listed: (string | undefined)[] = [];
  const approvals: ApprovalRepo = {
    async create() { return "x"; },
    async list(status) { listed.push(status); return [view()]; },
    async get(id) { return id === "ap-1" ? view() : undefined; },
    async createManual(caseId, input) { manualCalls.push({ caseId, input }); return o.manual ?? { ok: true, approvalId: "ap-m", paramsHash: HASH, amountMinor: input.amountMinor }; },
    async approve(id, input) { approveCalls.push({ id, input }); return o.approve ?? { ok: true, amountMinor: input.amountMinor ?? 1900 }; },
    async reject(id, hash) { rejectCalls.push([id, hash]); return o.reject ?? { ok: true }; },
    async caseIdFor() { return "case-1"; },
  };
  const runApproved = async (id: string) => {
    ran.push(id);
    if (o.runThrows) throw new Error("db down");
    return { status: "resolved", reason: "refunded $19.00 (REF-1)" };
  };
  const cases: CaseRepo = { ...casesStub, async decline(id) { declined.push(id); return o.decline ?? "declined"; } };
  const app = adminRoutes(o.configured === false ? { cases, adminToken: TOKEN } : { cases, approvals, runApproved, adminToken: TOKEN });
  const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { call, approveCalls, rejectCalls, ran, listed, manualCalls, declined };
}

describe("approval routes", () => {
  it("require the admin token and never run anything without it", async () => {
    const s = setup();
    for (const [m, p] of [["GET", "/approvals"], ["GET", "/approvals/ap-1"], ["POST", "/approvals/ap-1/approve"], ["POST", "/approvals/ap-1/reject"]] as const) {
      expect((await s.call(m, p, m === "POST" ? { paramsHash: HASH } : undefined, null)).status).toBe(401);
      expect((await s.call(m, p, m === "POST" ? { paramsHash: HASH } : undefined, "wrong")).status).toBe(401);
    }
    expect(s.approveCalls).toHaveLength(0);
    expect(s.rejectCalls).toHaveLength(0);
    expect(s.ran).toHaveLength(0);
  });

  it("answer 503 when approvals are not configured", async () => {
    const s = setup({ configured: false });
    expect((await s.call("GET", "/approvals")).status).toBe(503);
    expect((await s.call("POST", "/approvals/ap-1/approve", { paramsHash: HASH })).status).toBe(503);
    expect((await s.call("POST", "/approvals/ap-1/reject", { paramsHash: HASH })).status).toBe(503);
  });

  it("list defaults to pending and passes a status filter through; get returns one or 404", async () => {
    const s = setup();
    const res = await s.call("GET", "/approvals");
    expect(((await res.json()) as { approvals: unknown[] }).approvals).toHaveLength(1);
    await s.call("GET", "/approvals?status=approved");
    expect(s.listed).toEqual(["pending", "approved"]);
    expect((await s.call("GET", "/approvals/ap-1")).status).toBe(200);
    expect((await s.call("GET", "/approvals/nope")).status).toBe(404);
  });

  it("approve: records the approval first, then executes it, and reports the outcome", async () => {
    const s = setup();
    const res = await s.call("POST", "/approvals/ap-1/approve", { paramsHash: HASH, amountMinor: 1500 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approved: true, amountMinor: 1500, caseStatus: "resolved", detail: "refunded $19.00 (REF-1)" });
    expect(s.approveCalls).toEqual([{ id: "ap-1", input: { paramsHash: HASH, amountMinor: 1500 } }]);
    expect(s.ran).toEqual(["ap-1"]);
  });

  it("approve rejects malformed bodies before touching anything", async () => {
    const s = setup();
    for (const body of [{}, { paramsHash: "short" }, { paramsHash: HASH, amountMinor: 0 }, { paramsHash: HASH, amountMinor: -5 }, { paramsHash: HASH, amountMinor: 12.5 }, { paramsHash: HASH, amountMinor: 99_999_999 }, { paramsHash: HASH, amountMinor: "100" }]) {
      expect((await s.call("POST", "/approvals/ap-1/approve", body)).status).toBe(400);
    }
    expect(s.approveCalls).toHaveLength(0);
    expect(s.ran).toHaveLength(0);
  });

  it("every refusal maps to a clear status and never starts an execution", async () => {
    const cases = { not_found: 404, not_pending: 409, expired: 410, hash_mismatch: 409, amount_required: 422, exceeds_refundable: 422, order_not_ready: 422 } as const;
    for (const [error, status] of Object.entries(cases) as [keyof typeof cases, number][]) {
      const s = setup({ approve: { ok: false, error } });
      const res = await s.call("POST", "/approvals/ap-1/approve", { paramsHash: HASH });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
      expect(s.ran).toHaveLength(0);
    }
  });

  it("if execution crashes after the approval was recorded, the error surfaces (the sweeper will finish it)", async () => {
    const s = setup({ runThrows: true });
    const res = await s.call("POST", "/approvals/ap-1/approve", { paramsHash: HASH });
    expect(res.status).toBe(500);
    expect(s.approveCalls).toHaveLength(1);
  });

  it("reject needs the reviewed hash and maps outcomes", async () => {
    const s = setup();
    expect((await s.call("POST", "/approvals/ap-1/reject", {})).status).toBe(400);
    expect((await s.call("POST", "/approvals/ap-1/reject", { paramsHash: HASH })).status).toBe(200);
    expect(s.rejectCalls).toEqual([["ap-1", HASH]]);
    expect((await setup({ reject: { ok: false, error: "not_found" } }).call("POST", "/approvals/x/reject", { paramsHash: HASH })).status).toBe(404);
    expect((await setup({ reject: { ok: false, error: "hash_mismatch" } }).call("POST", "/approvals/x/reject", { paramsHash: HASH })).status).toBe(409);
    expect((await setup({ reject: { ok: false, error: "not_pending" } }).call("POST", "/approvals/x/reject", { paramsHash: HASH })).status).toBe(409);
  });

  it("resolve: a merchant refund becomes a pending approval (not an execution) and returns the hash to confirm", async () => {
    const s = setup();
    const res = await s.call("POST", "/cases/case-1/resolve", { action: "refund", remedy: "partial_tier_a", amountMinor: 1900 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ approvalId: "ap-m", paramsHash: HASH, amountMinor: 1900 });
    expect(s.manualCalls).toEqual([{ caseId: "case-1", input: { remedy: "partial_tier_a", amountMinor: 1900 } }]);
    expect(s.ran).toHaveLength(0); // nothing is executed until the approval is confirmed
  });

  it("resolve: decline closes the case without touching approvals", async () => {
    const s = setup();
    expect((await s.call("POST", "/cases/case-1/resolve", { action: "decline" })).status).toBe(200);
    expect(s.declined).toEqual(["case-1"]);
    expect(s.manualCalls).toHaveLength(0);
    expect((await setup({ decline: "not_found" }).call("POST", "/cases/x/resolve", { action: "decline" })).status).toBe(404);
    expect((await setup({ decline: "not_declinable" }).call("POST", "/cases/x/resolve", { action: "decline" })).status).toBe(409);
  });

  it("resolve: validates the body and maps every refusal", async () => {
    const s = setup();
    for (const body of [{}, { action: "refund" }, { action: "refund", remedy: "escalate", amountMinor: 100 }, { action: "refund", remedy: "full_refund", amountMinor: 0 }, { action: "refund", remedy: "full_refund", amountMinor: 1.5 }, { action: "approve" }]) {
      expect((await s.call("POST", "/cases/case-1/resolve", body)).status).toBe(400);
    }
    expect(s.manualCalls).toHaveLength(0);
    const map = { not_found: 404, not_resolvable: 409, no_agent_run: 422, no_policy: 422, order_not_ready: 422, exceeds_refundable: 422 } as const;
    for (const [error, status] of Object.entries(map) as [keyof typeof map, number][]) {
      const r = await setup({ manual: { ok: false, error } }).call("POST", "/cases/case-1/resolve", { action: "refund", remedy: "full_refund", amountMinor: 100 });
      expect(r.status).toBe(status);
    }
  });

  it("resolve requires the admin token", async () => {
    const s = setup();
    expect((await s.call("POST", "/cases/case-1/resolve", { action: "decline" }, null)).status).toBe(401);
    expect(s.declined).toHaveLength(0);
  });
});
