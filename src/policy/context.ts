// Context builder: turns raw facts (rows, timestamps) into the plain numbers the engine's rules read.
// Pure: `now` is passed in. The code that fetches the facts from Postgres/PayPal comes later (needs cases).

const DAY_MS = 86_400_000;

export interface Refund {
  amountMinor: number;
  createdAt: Date;
  origin: "countersign" | "external";
}

export interface ContextFacts {
  now: Date;
  order: { amountMinor: number; currency: string; deliveredAt: Date | null };
  capture: { amountMinor: number; currency: string };
  captureRefunds: { amountMinor: number }[]; // every refund on THIS capture, any origin
  buyerRefunds: Refund[]; // every refund to this buyer, any capture
  merchantRefunds: Refund[]; // every refund by this merchant (used for the daily cap)
  disputeStage: string | null;
  allowedResponseOptions: string[] | null;
}

export interface Context {
  currency: string;
  captureAmountMinor: number;
  orderTotalMinor: number;
  refundableMinor: number; // capture minus refunds; PayPal's capture GET does not give this (Day 0 finding)
  refundsTodayMinor: number; // Countersign-issued refunds since 00:00 UTC
  buyerRefunds90dCount: number;
  buyerRefunds90dMinor: number;
  daysSinceDelivery: number | null; // null = unknown; rules that need it do not match
  disputeStage: string | null;
  allowedResponseOptions: string[] | null;
}

const sum = (xs: { amountMinor: number }[]) => xs.reduce((a, x) => a + x.amountMinor, 0);

function sameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

export function buildContext(f: ContextFacts): Context {
  const nowMs = f.now.getTime();

  const refundable = Math.max(0, f.capture.amountMinor - sum(f.captureRefunds));

  const refundsToday = sum(f.merchantRefunds.filter((r) => r.origin === "countersign" && sameUtcDay(r.createdAt, f.now)));

  const buyer90 = f.buyerRefunds.filter((r) => {
    const t = r.createdAt.getTime();
    // No upper bound on purpose: a refund stamped after our clock was read (a concurrent claim, or clock skew) must still
    // count. Counting too much only sends a case to approval; counting too little pays money out of policy.
    return nowMs - t <= 90 * DAY_MS;
  });

  let daysSinceDelivery: number | null = null;
  if (f.order.deliveredAt) {
    const elapsed = nowMs - f.order.deliveredAt.getTime();
    daysSinceDelivery = elapsed >= 0 ? Math.floor(elapsed / DAY_MS) : null; // delivery "in the future" is bad data
  }

  return {
    currency: f.capture.currency,
    captureAmountMinor: f.capture.amountMinor,
    orderTotalMinor: f.order.amountMinor,
    refundableMinor: refundable,
    refundsTodayMinor: refundsToday,
    buyerRefunds90dCount: buyer90.length,
    buyerRefunds90dMinor: sum(buyer90),
    daysSinceDelivery,
    disputeStage: f.disputeStage,
    allowedResponseOptions: f.allowedResponseOptions,
  };
}
