import { describe, expect, it } from "vitest";
import type { ApprovalRepo } from "../src/db/approvals.js";
import type { CaseRepo } from "../src/db/cases.js";
import type { DemoRepo, ResetResult } from "../src/db/demo.js";
import type { PolicyRepo } from "../src/db/policies.js";
import { loadConfig } from "../src/config.js";
import { adminRoutes } from "../src/routes/admin.js";
import { policyRoutes } from "../src/routes/policies.js";

const ADMIN = "admin-token-aaaaaaaaaaaa";
const JUDGE = "judge-token-bbbbbbbbbbbb";
const HASH = "a".repeat(64);

function setup(o: { resetEnabled?: boolean; reset?: ResetResult; judge?: string | null; admin?: string | null } = {}) {
  const calls: string[] = [];
  const cases: CaseRepo = {
    async list() { calls.push("cases.list"); return []; },
    async decline() { calls.push("cases.decline"); return "declined"; },
    async open() { calls.push("cases.open"); return { ok: false, error: "unknown_order" }; },
    async status() { return undefined; },
    async timeline() { return undefined; },
    async markDelivered() { calls.push("cases.markDelivered"); return true; },
  };
  const approvals: ApprovalRepo = {
    async create() { return null; },
    async list() { calls.push("approvals.list"); return []; },
    async get() { return undefined; },
    async createManual() { calls.push("approvals.createManual"); return { ok: false, error: "not_found" }; },
    async approve() { calls.push("approvals.approve"); return { ok: true, amountMinor: 100 }; },
    async reject() { calls.push("approvals.reject"); return { ok: true }; },
    async caseIdFor() { return undefined; },
  };
  const demo: DemoRepo = { async reset() { calls.push("demo.reset"); return o.reset ?? { ok: true, deleted: { cases: 2, orders: 2 } }; } };
  const admin = adminRoutes({
    cases, approvals, runApproved: async () => { calls.push("runApproved"); return { status: "resolved", reason: "x" }; },
    adminToken: o.admin === null ? undefined : (o.admin ?? ADMIN), judgeToken: o.judge === null ? undefined : (o.judge ?? JUDGE), demo, resetEnabled: o.resetEnabled,
  });
  const policies: PolicyRepo = {
    async createDraft() { calls.push("policies.createDraft"); return { id: "p", version: 1 }; },
    async get() { return undefined; }, async getActive() { return undefined; }, async list() { return []; },
    async activate() { calls.push("policies.activate"); return "activated"; },
  };
  const policy = policyRoutes({ repo: policies, compile: async () => { calls.push("compile"); throw new Error("should not run"); }, adminToken: ADMIN, judgeToken: JUDGE });
  const call = (app: typeof admin, method: string, path: string, token: string | null, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { calls, admin, policy, a: (m: string, p: string, t: string | null, b?: unknown) => call(admin, m, p, t, b), p: (m: string, p: string, t: string | null, b?: unknown) => call(policy as unknown as typeof admin, m, p, t, b) };
}

describe("judge access (read-only)", () => {
  it("can read everything the console shows", async () => {
    const s = setup();
    expect((await s.a("GET", "/cases", JUDGE)).status).toBe(200);
    expect((await s.a("GET", "/approvals", JUDGE)).status).toBe(200);
    expect((await s.p("GET", "/", JUDGE)).status).toBe(200);
    expect((await s.p("GET", "/active", JUDGE)).status).toBe(404); // not "forbidden": reading is allowed, there is just no active policy here
  });

  it("is refused (403 read_only) on every write, and no write ever reaches a repository", async () => {
    const s = setup({ resetEnabled: true });
    const writes: [string, string, unknown][] = [
      ["POST", "/approvals/x/approve", { paramsHash: HASH }],
      ["POST", "/approvals/x/reject", { paramsHash: HASH }],
      ["POST", "/cases/x/resolve", { action: "decline" }],
      ["POST", "/cases/x/resolve", { action: "refund", remedy: "full_refund", amountMinor: 100 }],
      ["POST", "/orders/o/delivered", { daysAgo: 3 }],
      ["POST", "/reset", { confirm: "reset demo data" }],
      ["PUT", "/cases/x/resolve", {}],
      ["DELETE", "/cases/x", undefined],
    ];
    for (const [m, p, b] of writes) {
      const r = await s.a(m, p, JUDGE, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(await r.json()).toEqual({ error: "read_only" });
    }
    for (const [m, p, b] of [["POST", "/compile", { prose: "a policy that is long enough to pass validation" }], ["POST", "/x/activate", { confirm: true, rulesHash: HASH }]] as const) {
      expect((await s.p(m, p, JUDGE, b)).status, `${m} ${p}`).toBe(403);
    }
    expect(s.calls.filter((c) => !c.endsWith(".list"))).toEqual([]); // nothing but reads happened
  });

  it("whoami tells the console which role it has", async () => {
    const s = setup({ resetEnabled: true });
    expect(await (await s.a("GET", "/whoami", JUDGE)).json()).toEqual({ role: "judge", resetEnabled: true });
    expect(await (await s.a("GET", "/whoami", ADMIN)).json()).toEqual({ role: "admin", resetEnabled: true });
    expect((await (await setup().a("GET", "/whoami", ADMIN)).json()) as { resetEnabled: boolean }).toMatchObject({ resetEnabled: false });
  });
});

describe("tokens", () => {
  it("the admin token can still do everything a judge cannot", async () => {
    const s = setup();
    expect((await s.a("POST", "/approvals/x/approve", ADMIN, { paramsHash: HASH })).status).toBe(200);
    expect((await s.a("POST", "/approvals/x/reject", ADMIN, { paramsHash: HASH })).status).toBe(200);
    expect(s.calls).toContain("approvals.approve");
    expect(s.calls).toContain("runApproved");
  });

  it("rejects a missing, wrong or look-alike token with 401", async () => {
    const s = setup();
    for (const t of [null, "", "wrong", `${JUDGE}x`, ADMIN.slice(1), JUDGE.toUpperCase()]) expect((await s.a("GET", "/cases", t)).status, String(t)).toBe(401);
    expect((await s.a("POST", "/reset", "nope", { confirm: "reset demo data" })).status).toBe(401);
  });

  it("with no judge token configured, there is no judge access at all", async () => {
    const s = setup({ judge: null });
    expect((await s.a("GET", "/cases", JUDGE)).status).toBe(401);
    expect((await s.a("GET", "/cases", ADMIN)).status).toBe(200);
  });

  it("answers 503 for everyone (judges included) when no admin token is configured", async () => {
    const s = setup({ admin: null });
    expect((await s.a("GET", "/cases", JUDGE)).status).toBe(503);
    expect((await s.a("GET", "/cases", ADMIN)).status).toBe(503);
  });
});

describe("demo reset", () => {
  it("is off by default, even for the admin", async () => {
    const s = setup();
    const r = await s.a("POST", "/reset", ADMIN, { confirm: "reset demo data" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "reset_disabled" });
    expect(s.calls).not.toContain("demo.reset");
  });

  it("needs the exact typed phrase", async () => {
    const s = setup({ resetEnabled: true });
    for (const body of [{}, { confirm: "yes" }, { confirm: "RESET DEMO DATA" }, { confirm: true }, { confirm: "reset demo data " }]) {
      expect((await s.a("POST", "/reset", ADMIN, body)).status).toBe(400);
    }
    expect(s.calls).not.toContain("demo.reset");
  });

  it("runs when enabled, confirmed and signed in as admin, and reports what was removed", async () => {
    const s = setup({ resetEnabled: true });
    const r = await s.a("POST", "/reset", ADMIN, { confirm: "reset demo data" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ reset: true, deleted: { cases: 2, orders: 2 } });
    expect(s.calls).toContain("demo.reset");
  });

  it("answers 409 and changes nothing while a refund is still in flight", async () => {
    const s = setup({ resetEnabled: true, reset: { ok: false, error: "payments_in_flight" } });
    const r = await s.a("POST", "/reset", ADMIN, { confirm: "reset demo data" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "payments_in_flight" });
  });
});

describe("configuration", () => {
  const base = { PAYPAL_ENV: "sandbox", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", DATABASE_URL: "postgres://x" };

  it("a judge token must differ from the admin token and be long enough", () => {
    expect(() => loadConfig({ ...base, ADMIN_TOKEN: ADMIN, JUDGE_TOKEN: ADMIN })).toThrow(/JUDGE_TOKEN must differ/);
    expect(() => loadConfig({ ...base, ADMIN_TOKEN: ADMIN, JUDGE_TOKEN: "short" })).toThrow();
    expect(loadConfig({ ...base, ADMIN_TOKEN: ADMIN, JUDGE_TOKEN: JUDGE }).JUDGE_TOKEN).toBe(JUDGE);
    expect(loadConfig({ ...base, ADMIN_TOKEN: ADMIN }).JUDGE_TOKEN).toBeUndefined();
  });

  it("demo reset is off unless ALLOW_DEMO_RESET is exactly 'true'", () => {
    expect(loadConfig(base).ALLOW_DEMO_RESET).toBe(false);
    expect(loadConfig({ ...base, ALLOW_DEMO_RESET: "true" }).ALLOW_DEMO_RESET).toBe(true);
    expect(loadConfig({ ...base, ALLOW_DEMO_RESET: "false" }).ALLOW_DEMO_RESET).toBe(false);
    for (const v of ["1", "yes", "TRUE", ""]) expect(() => loadConfig({ ...base, ALLOW_DEMO_RESET: v })).toThrow();
  });
});
