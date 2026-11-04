import { describe, expect, it } from "vitest";
import type { OrderRepo, OrderRow } from "../src/db/repos.js";
import { PayPalError } from "../src/paypal/client.js";
import { storeRoutes } from "../src/routes/store.js";

function setup(opts: { paypalFails?: boolean } = {}) {
  const rows = new Map<string, OrderRow & { amountMinor: number }>();
  const created: { amountMinor: number; requestId: string }[] = [];
  const captured: { orderId: string; requestId: string }[] = [];
  const orders: OrderRepo = {
    async insertOrder(o) { rows.set(o.paypalOrderId, { id: "o1", paypalOrderId: o.paypalOrderId, captureId: null, amountMinor: o.amountMinor }); },
    async findByPaypalOrderId(id) { return rows.get(id); },
    async setCapture(id, c) { const r = rows.get(id); if (r) r.captureId = c.captureId; },
  };
  const paypal = {
    async createOrder(p: { amountMinor: number; requestId: string }) {
      if (opts.paypalFails) throw new PayPalError(500, {}, "dbg");
      created.push(p);
      return { id: "ORDER1", status: "CREATED" };
    },
    async captureOrder(orderId: string, requestId: string) {
      captured.push({ orderId, requestId });
      return { id: orderId, status: "COMPLETED", payer: { payer_id: "P1" }, purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED" }] } }] };
    },
  };
  const app = storeRoutes({ paypal, orders });
  const post = (path: string, body?: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { post, rows, created, captured };
}

describe("store routes", () => {
  it("prices the order on the server from the SKU", async () => {
    const s = setup();
    const res = await s.post("/orders", { sku: "mug" });
    expect(await res.json()).toEqual({ orderId: "ORDER1" });
    expect(s.created[0]?.amountMinor).toBe(3800);
  });

  it("ignores any amount a client tries to send", async () => {
    const s = setup();
    await s.post("/orders", { sku: "mug", amountMinor: 1 });
    expect(s.created[0]?.amountMinor).toBe(3800);
  });

  it("rejects unknown SKUs", async () => {
    const s = setup();
    expect((await s.post("/orders", { sku: "yacht" })).status).toBe(400);
    expect((await s.post("/orders")).status).toBe(400);
  });

  it("only captures orders we created", async () => {
    const s = setup();
    expect((await s.post("/orders/STRANGER/capture")).status).toBe(404);
    expect(s.captured).toHaveLength(0);
  });

  it("captures with a request id derived from the order, so retries replay", async () => {
    const s = setup();
    await s.post("/orders", { sku: "mug" });
    await s.post("/orders/ORDER1/capture");
    await s.post("/orders/ORDER1/capture");
    expect(new Set(s.captured.map((c) => c.requestId)).size).toBe(1);
    expect(s.rows.get("ORDER1")?.captureId).toBe("CAP1");
  });

  it("maps PayPal failures to 502 without leaking the body", async () => {
    const s = setup({ paypalFails: true });
    const res = await s.post("/orders", { sku: "mug" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "paypal_error", debugId: "dbg" });
  });
});
