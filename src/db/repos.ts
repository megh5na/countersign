import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { decimalToMinor } from "../money.js";
import type { Db } from "./client.js";
import { orders, refundLedger, webhookEvents } from "./schema.js";

export const WebhookEvent = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource: z.unknown(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export interface WebhookRepo {
  // "retry" = stored earlier but never finished processing (e.g. crash between insert and apply)
  recordEvent(e: { paypalEventId: string; type: string; payload: unknown }): Promise<"new" | "retry" | "duplicate">;
  applyEvent(e: WebhookEvent): Promise<void>;
  markProcessed(paypalEventId: string): Promise<void>;
}

export interface OrderRow {
  id: string;
  paypalOrderId: string;
  captureId: string | null;
}

export interface OrderRepo {
  insertOrder(o: { paypalOrderId: string; amountMinor: number; currency: string }): Promise<void>;
  findByPaypalOrderId(paypalOrderId: string): Promise<OrderRow | undefined>;
  setCapture(paypalOrderId: string, c: { captureId: string; payerId?: string; buyerEmail?: string }): Promise<void>;
}

const CaptureCompleted = z.object({
  id: z.string(),
  supplementary_data: z.object({ related_ids: z.object({ order_id: z.string() }) }).optional(),
});

const CaptureRefunded = z.object({
  id: z.string(),
  amount: z.object({ value: z.string(), currency_code: z.string() }),
  links: z.array(z.object({ href: z.string(), rel: z.string() })),
});

export function createWebhookRepo(db: Db): WebhookRepo {
  return {
    async recordEvent(e) {
      const inserted = await db
        .insert(webhookEvents)
        .values({ id: randomUUID(), paypalEventId: e.paypalEventId, type: e.type, payload: e.payload, verified: 1 })
        .onConflictDoNothing({ target: webhookEvents.paypalEventId }) // I9: unique event id
        .returning({ id: webhookEvents.id });
      if (inserted.length > 0) return "new";
      const [existing] = await db
        .select({ processedAt: webhookEvents.processedAt })
        .from(webhookEvents)
        .where(eq(webhookEvents.paypalEventId, e.paypalEventId));
      return existing?.processedAt ? "duplicate" : "retry";
    },

    // Every branch is idempotent, so "retry" can safely re-run it.
    async applyEvent(e) {
      if (e.event_type === "PAYMENT.CAPTURE.COMPLETED") {
        const r = CaptureCompleted.safeParse(e.resource);
        const orderId = r.success ? r.data.supplementary_data?.related_ids.order_id : undefined;
        if (r.success && orderId) {
          await db.update(orders).set({ captureId: r.data.id }).where(eq(orders.paypalOrderId, orderId));
        }
      } else if (e.event_type === "PAYMENT.CAPTURE.REFUNDED") {
        const r = CaptureRefunded.safeParse(e.resource);
        const up = r.success ? r.data.links.find((l) => l.rel === "up") : undefined;
        if (r.success && up) {
          // Refunds we issue ourselves are inserted first by the executor, so this is a no-op for them.
          // Anything else (made in PayPal's UI) is recorded as external so caps still see it.
          await db
            .insert(refundLedger)
            .values({
              id: randomUUID(),
              captureId: up.href.split("/").pop() ?? "",
              amountMinor: decimalToMinor(r.data.amount.value),
              currency: r.data.amount.currency_code,
              paypalRefundId: r.data.id,
              origin: "external",
            })
            .onConflictDoNothing({ target: refundLedger.paypalRefundId });
        }
      }
    },

    async markProcessed(paypalEventId) {
      await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.paypalEventId, paypalEventId));
    },
  };
}

export function createOrderRepo(db: Db): OrderRepo {
  return {
    async insertOrder(o) {
      await db.insert(orders).values({ id: randomUUID(), ...o });
    },
    async findByPaypalOrderId(paypalOrderId) {
      const [row] = await db
        .select({ id: orders.id, paypalOrderId: orders.paypalOrderId, captureId: orders.captureId })
        .from(orders)
        .where(eq(orders.paypalOrderId, paypalOrderId));
      return row;
    },
    async setCapture(paypalOrderId, c) {
      await db
        .update(orders)
        .set({ captureId: c.captureId, payerId: c.payerId, buyerEmail: c.buyerEmail })
        .where(eq(orders.paypalOrderId, paypalOrderId));
    },
  };
}
