import { describe, expect, it } from "vitest";
import type { CaseRepo, OpenResult } from "../src/db/cases.js";
import { adminRoutes } from "../src/routes/admin.js";
import { caseRoutes, createLimiter } from "../src/routes/cases.js";

const TOKEN = "correct-horse-battery-staple";
const MSG = "My mug arrived in three pieces, please help.";

function setup(opts: { open?: OpenResult; max?: number; run?: ((id: string) => Promise<unknown>) | null } = {}) {
  const opened: { orderId: string; message: string }[] = [];
  const ran: string[] = [];
  const delivered: [string, number][] = [];
  const repo: CaseRepo = {
    async open(orderId, message) { opened.push({ orderId, message }); return opts.open ?? { ok: true, caseId: "case-1" }; },
    async status(id) { return id === "case-1" ? ({ status: "denied", reason: "R7: secret rule detail" } as { status: string }) : undefined; },
    async timeline(id) { return id === "case-1" ? { case: { id }, runs: [], toolCalls: [], proposals: [], decisions: [], executions: [] } : undefined; },
    async markDelivered(id, days) { delivered.push([id, days]); return id === "ORDER-1"; },
  };
  const limiter = createLimiter(opts.max ?? 3);
  const run = opts.run === null ? undefined : (opts.run ?? (async (id: string) => { ran.push(id); }));
  const app = caseRoutes({ cases: repo, run, limiter });
  const admin = adminRoutes({ cases: repo, adminToken: TOKEN });
  const post = (body: unknown) => app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const adminCall = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    admin.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, post, adminCall, opened, ran, delivered, limiter };
}

describe("case form (public)", () => {
  it("accepts a claim with 202 and starts the pipeline without waiting for it", async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((r) => { finish = r; });
    const s = setup({ run: () => gate });
    const res = await s.post({ orderId: "ORDER-1", message: MSG });
    expect(res.status).toBe(202); // answered while the run is still pending
    expect(await res.json()).toEqual({ caseId: "case-1", status: "open" });
    finish();
  });

  it("answers 503 when no agent is configured, and opens nothing", async () => {
    const s = setup({ run: null });
    expect((await s.post({ orderId: "ORDER-1", message: MSG })).status).toBe(503);
    expect(s.opened).toHaveLength(0);
  });

  it("rejects bad input before touching the database or the model", async () => {
    const s = setup();
    for (const body of [{}, { orderId: "ORDER-1" }, { message: MSG }, { orderId: "", message: MSG }, { orderId: "ORDER-1", message: "too short" }, { orderId: "ORDER-1", message: "x".repeat(2001) }, { orderId: "x".repeat(65), message: MSG }]) {
      expect((await s.post(body)).status).toBe(400);
    }
    expect(s.opened).toHaveLength(0);
    expect(s.ran).toHaveLength(0);
  });

  it("maps unknown order, uncaptured order and a duplicate live case to clear errors, and runs nothing", async () => {
    expect((await setup({ open: { ok: false, error: "unknown_order" } }).post({ orderId: "X", message: MSG })).status).toBe(404);
    expect((await setup({ open: { ok: false, error: "not_captured" } }).post({ orderId: "X", message: MSG })).status).toBe(422);
    const dup = setup({ open: { ok: false, error: "duplicate_active" } });
    expect((await dup.post({ orderId: "X", message: MSG })).status).toBe(409);
    expect(dup.ran).toHaveLength(0);
  });

  it("caps concurrent model runs (429) and frees capacity when a run ends, even if it crashes", async () => {
    const gates: (() => void)[] = [];
    const s = setup({ max: 2, run: () => new Promise<void>((r) => gates.push(r)) });
    expect((await s.post({ orderId: "A", message: MSG })).status).toBe(202);
    expect((await s.post({ orderId: "B", message: MSG })).status).toBe(202);
    expect((await s.post({ orderId: "C", message: MSG })).status).toBe(429);
    gates[0]?.();
    await new Promise((r) => setTimeout(r, 0));
    expect((await s.post({ orderId: "D", message: MSG })).status).toBe(202);

    const crashing = setup({ max: 1, run: async () => { throw new Error("boom"); } });
    expect((await crashing.post({ orderId: "A", message: MSG })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect((await crashing.post({ orderId: "B", message: MSG })).status).toBe(202); // slot was released
  });

  it("rejected requests do not leak limiter slots", async () => {
    const s = setup({ max: 1, open: { ok: false, error: "duplicate_active" } });
    for (let i = 0; i < 5; i++) expect((await s.post({ orderId: "A", message: MSG })).status).toBe(409);
    expect(s.limiter.tryAcquire()).toBe(true);
  });

  it("the buyer-facing status shows only the status, never the reason", async () => {
    const s = setup();
    const res = await s.app.request("/case-1");
    expect(await res.json()).toEqual({ status: "denied" });
    expect((await s.app.request("/nope")).status).toBe(404);
  });
});

describe("admin routes", () => {
  it("require the admin token", async () => {
    const s = setup();
    expect((await s.adminCall("GET", "/cases/case-1", undefined, null)).status).toBe(401);
    expect((await s.adminCall("GET", "/cases/case-1", undefined, "wrong")).status).toBe(401);
    expect((await s.adminCall("POST", "/orders/ORDER-1/delivered", { daysAgo: 5 }, null)).status).toBe(401);
    expect(s.delivered).toHaveLength(0);
  });

  it("answer 503 when no token is configured", async () => {
    const res = await adminRoutes({ cases: setup().app as unknown as CaseRepo, adminToken: undefined }).request("/cases/x");
    expect(res.status).toBe(503);
  });

  it("serve the full timeline to an admin", async () => {
    const s = setup();
    const res = await s.adminCall("GET", "/cases/case-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ case: { id: "case-1" }, executions: [] });
    expect((await s.adminCall("GET", "/cases/missing")).status).toBe(404);
  });

  it("mark an order delivered N days ago, validating the input", async () => {
    const s = setup();
    expect((await s.adminCall("POST", "/orders/ORDER-1/delivered", { daysAgo: 12 })).status).toBe(200);
    expect(s.delivered).toEqual([["ORDER-1", 12]]);
    expect((await s.adminCall("POST", "/orders/ORDER-1/delivered", { daysAgo: -1 })).status).toBe(400);
    expect((await s.adminCall("POST", "/orders/ORDER-1/delivered", { daysAgo: 1.5 })).status).toBe(400);
    expect((await s.adminCall("POST", "/orders/ORDER-1/delivered", { daysAgo: 9999 })).status).toBe(400);
    expect((await s.adminCall("POST", "/orders/NOPE/delivered", { daysAgo: 1 })).status).toBe(404);
  });
});
