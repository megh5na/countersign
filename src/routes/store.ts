import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { OrderRepo } from "../db/repos.js";
import { PayPalError, type PayPalClient } from "../paypal/client.js";

// Prices live on the server. The browser sends a SKU, never an amount.
export const CATALOG = {
  mug: { name: "Hand-thrown ceramic mug", amountMinor: 3800, currency: "USD" },
} as const;

const CreateBody = z.object({ sku: z.enum(["mug"]) });

interface Deps {
  paypal: Pick<PayPalClient, "createOrder" | "captureOrder">;
  orders: OrderRepo;
}

export function storeRoutes({ paypal, orders }: Deps) {
  const app = new Hono();

  app.post("/orders", async (c) => {
    const body = CreateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_sku" }, 400);
    const item = CATALOG[body.data.sku];
    try {
      const order = await paypal.createOrder({
        amountMinor: item.amountMinor,
        currency: item.currency,
        description: item.name,
        requestId: randomUUID(),
      });
      await orders.insertOrder({ paypalOrderId: order.id, amountMinor: item.amountMinor, currency: item.currency });
      return c.json({ orderId: order.id });
    } catch (e) {
      if (e instanceof PayPalError) return c.json({ error: "paypal_error", debugId: e.debugId }, 502);
      throw e;
    }
  });

  app.post("/orders/:orderId/capture", async (c) => {
    const orderId = c.req.param("orderId");
    // Only orders we created can be captured here.
    if (!(await orders.findByPaypalOrderId(orderId))) return c.json({ error: "unknown_order" }, 404);
    try {
      // Request id derived from the order: a double click or retry replays the same capture instead of repeating it.
      const result = await paypal.captureOrder(orderId, `capture-${orderId}`);
      const capture = result.purchase_units[0]?.payments.captures[0];
      if (capture) {
        await orders.setCapture(orderId, {
          captureId: capture.id,
          payerId: result.payer?.payer_id,
          buyerEmail: result.payer?.email_address,
        });
      }
      return c.json({ status: result.status, captureId: capture?.id ?? null });
    } catch (e) {
      if (e instanceof PayPalError) return c.json({ error: "paypal_error", debugId: e.debugId }, 502);
      throw e;
    }
  });

  return app;
}
