import { describe, expect, it } from "vitest";
import type { ApprovalRepo, ApprovalView, ApproveResult, RejectResult } from "../src/db/approvals.js";
import type { CaseRepo } from "../src/db/cases.js";
import { adminRoutes } from "../src/routes/admin.js";

const TOKEN = "correct-horse-battery-staple";
const HASH = "a".repeat(64);
const casesStub: CaseRepo = { open: async () => ({ ok: false, error: "unknown_order" }), status: async () => undefined, timeline: async () => undefined, markDelivered: async () => false };
const view = (over: Partial<ApprovalView> = {}): ApprovalView => ({
  id: "ap-1", status: "pending", paramsHash: HASH, suggestedAmountMinor: 1900, expiresAt: new Date(), createdAt: new Date(), caseId: "case-1", paypalOrderId: "PP-1",
  orderTotalMinor: 3800, remedy: "partial_tier_b", claimType: "damaged", buyerMessage: "broken", agentDraft: "sorry", ruleIds: ["SYS_NO_MATCH"], reasons: [], ...over,
});

function setup(o: { approve?: ApproveResult; reject?: RejectResult; configured?: boolean; runThrows?: boolean } = {}) {
  const approveCalls: { id: string; input: { paramsHash: string; amountMinor?: number } }[] = [];
  const rejectCalls: [string, string][] = [];
  const ran: string[] = [];
  const listed: (string | undefined)[] = [];
  const approvals: ApprovalRepo = {
    async create() { return "x"; },
    async list(status) { listed.push(status); return [view()]; },
    async get(id) { return id === "ap-1" ? view() : undefined; },
    async approve(id, input) { approveCalls.push({ id, input }); return o.approve ?? { ok: true, amountMinor: input.amountMinor ?? 1900 }; },
    async reject(id, hash) { rejectCalls.push([id, hash]); return o.reject ?? { ok: true }; },
    async caseIdFor() { return "case-1"; },
  };
  const runApproved = async (id: string) => {
    ran.push(id);
    if (o.runThrows) throw new Error("db down");
    return { status: "resolved", reason: "refunded 1900 minor units (REF-1)" };
  };
  const app = adminRoutes(o.configured === false ? { cases: casesStub, adminToken: TOKEN } : { cases: casesStub, approvals, runApproved, adminToken: TOKEN });
  const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { call, approveCalls, rejectCalls, ran, listed };
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
    expect(await res.json()).toEqual({ approved: true, amountMinor: 1500, caseStatus: "resolved", detail: "refunded 1900 minor units (REF-1)" });
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
});
