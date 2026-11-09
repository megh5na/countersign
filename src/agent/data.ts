// Postgres-backed reads for the agent's tools. Read-only by construction: this file contains only selects.

import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orders, refundLedger } from "../db/schema.js";
import type { AgentData } from "./tools.js";

export function createAgentData(db: Db): AgentData {
  const live = ne(refundLedger.status, "failed");
  return {
    async getOrder(orderId) {
      const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
      return o && { id: o.id, amountMinor: o.amountMinor, currency: o.currency, captureId: o.captureId, payerId: o.payerId, deliveredAt: o.deliveredAt, trackingNo: o.trackingNo };
    },

    async refundsForCapture(captureId) {
      return db
        .select({ amountMinor: refundLedger.amountMinor, createdAt: refundLedger.createdAt, origin: refundLedger.origin })
        .from(refundLedger)
        .where(and(eq(refundLedger.captureId, captureId), live));
    },

    async buyerHistory(payerId, now) {
      const since = new Date(now.getTime() - 90 * 86_400_000);
      const [o] = await db.select({ n: count() }).from(orders).where(eq(orders.payerId, payerId));
      const [r] = await db
        .select({ n: count(), total: sql<number>`coalesce(sum(${refundLedger.amountMinor}), 0)` })
        .from(refundLedger)
        .innerJoin(orders, eq(orders.captureId, refundLedger.captureId))
        .where(and(eq(orders.payerId, payerId), live, gte(refundLedger.createdAt, since)));
      return { orderCount: o?.n ?? 0, refundCount90d: r?.n ?? 0, refundMinor90d: Number(r?.total ?? 0) };
    },
  };
}
