// Loads the facts the policy engine reasons about, straight from our own database.
// Used by the executor (under its lock) and by the pipeline (to record the decision's context).
// The model never supplies these numbers (I2).

import { and, eq, gte, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orders, refundLedger } from "../db/schema.js";
import type { ContextFacts } from "../policy/context.js";

export type Reader = Pick<Db, "select">; // satisfied by both the db and a transaction
export type OrderRow = typeof orders.$inferSelect;

const DAY_MS = 86_400_000;

export async function loadFacts(r: Reader, order: OrderRow, captureId: string, payerId: string, now: Date): Promise<ContextFacts> {
  const live = ne(refundLedger.status, "failed"); // reserved + completed count; failed does not
  const startOfUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fields = { amountMinor: refundLedger.amountMinor, createdAt: refundLedger.createdAt, origin: refundLedger.origin };

  const captureRows = await r.select({ amountMinor: refundLedger.amountMinor }).from(refundLedger).where(and(eq(refundLedger.captureId, captureId), live));
  const buyerRows = await r
    .select(fields)
    .from(refundLedger)
    .innerJoin(orders, eq(orders.captureId, refundLedger.captureId))
    .where(and(eq(orders.payerId, payerId), live, gte(refundLedger.createdAt, new Date(now.getTime() - 90 * DAY_MS))));
  const merchantRows = await r.select(fields).from(refundLedger).where(and(live, gte(refundLedger.createdAt, startOfUtcDay)));
  const asRefund = (x: (typeof buyerRows)[number]) => ({ amountMinor: x.amountMinor, createdAt: x.createdAt, origin: x.origin as "countersign" | "external" });

  return {
    now,
    order: { amountMinor: order.amountMinor, currency: order.currency, deliveredAt: order.deliveredAt },
    capture: { amountMinor: order.amountMinor, currency: order.currency },
    captureRefunds: captureRows,
    buyerRefunds: buyerRows.map(asRefund),
    merchantRefunds: merchantRows.map(asRefund),
    disputeStage: null,
    allowedResponseOptions: null,
  };
}
