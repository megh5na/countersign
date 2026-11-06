import { describe, expect, it } from "vitest";
import type { WebhookEvent, WebhookRepo } from "../src/db/repos.js";
import { webhookRoutes } from "../src/routes/webhooks.js";

const headers = {
  "content-type": "application/json",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "tx1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-11-04T10:00:00Z",
};

const event = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "C1" } };

function setup(opts: { verified?: boolean; verifyThrows?: boolean; seen?: "new" | "retry" | "duplicate"; applyThrows?: boolean; webhookId?: string | null } = {}) {
  const applied: WebhookEvent[] = [];
  const processed: string[] = [];
  const recorded: string[] = [];
  const repo: WebhookRepo = {
    async recordEvent(e) { recorded.push(e.paypalEventId); return opts.seen ?? "new"; },
    async applyEvent(e) { if (opts.applyThrows) throw new Error("db down"); applied.push(e); },
    async markProcessed(id) { processed.push(id); },
  };
  const paypal = {
    async verifyWebhook() { if (opts.verifyThrows) throw new Error("paypal down"); return opts.verified ?? true; },
  };
  const app = webhookRoutes({ paypal, repo, webhookId: opts.webhookId === null ? undefined : (opts.webhookId ?? "WID") });
  const post = (body: unknown, h: Record<string, string> = headers) =>
    app.request("/", { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { post, applied, processed, recorded };
}

describe("webhook route (invariant I9)", () => {
  it("verifies, records, applies and marks a new event processed", async () => {
    const s = setup();
    const res = await s.post(event);
    expect(res.status).toBe(200);
    expect(s.applied).toHaveLength(1);
    expect(s.processed).toEqual(["WH-1"]);
  });

  it("accepts a verified event that has no resource field", async () => {
    const s = setup();
    const res = await s.post({ id: "WH-2", event_type: "CUSTOMER.DISPUTE.CREATED" });
    expect(res.status).toBe(200);
    expect(s.processed).toEqual(["WH-2"]);
  });

  it("rejects an invalid signature and stores nothing", async () => {
    const s = setup({ verified: false });
    const res = await s.post(event);
    expect(res.status).toBe(400);
    expect(s.recorded).toHaveLength(0);
    expect(s.applied).toHaveLength(0);
  });

  it("rejects requests missing signature headers", async () => {
    const s = setup();
    const res = await s.post(event, { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect(s.recorded).toHaveLength(0);
  });

  it("returns 503 (so PayPal redelivers) when verification is unavailable", async () => {
    const s = setup({ verifyThrows: true });
    expect((await s.post(event)).status).toBe(503);
    expect(s.recorded).toHaveLength(0);
  });

  it("acknowledges duplicates without re-applying", async () => {
    const s = setup({ seen: "duplicate" });
    const res = await s.post(event);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true });
    expect(s.applied).toHaveLength(0);
  });

  it("re-applies an event that was stored but never finished", async () => {
    const s = setup({ seen: "retry" });
    expect((await s.post(event)).status).toBe(200);
    expect(s.applied).toHaveLength(1);
    expect(s.processed).toEqual(["WH-1"]);
  });

  it("does not mark processed when applying fails", async () => {
    const s = setup({ applyThrows: true });
    expect((await s.post(event)).status).toBe(500);
    expect(s.processed).toHaveLength(0);
  });

  it("refuses to run unconfigured instead of trusting events", async () => {
    const s = setup({ webhookId: null });
    expect((await s.post(event)).status).toBe(503);
  });

  it("rejects malformed bodies", async () => {
    const s = setup();
    expect((await s.post("not json")).status).toBe(400);
    expect((await s.post({ nope: 1 })).status).toBe(400);
  });
});
