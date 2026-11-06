import { describe, expect, it } from "vitest";
import { type ContextFacts, buildContext } from "../src/policy/context.js";

const NOW = new Date("2026-11-10T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const facts = (over: Partial<ContextFacts> = {}): ContextFacts => ({
  now: NOW,
  order: { amountMinor: 3800, currency: "USD", deliveredAt: daysAgo(10) },
  capture: { amountMinor: 3800, currency: "USD" },
  captureRefunds: [],
  buyerRefunds: [],
  merchantRefunds: [],
  disputeStage: null,
  allowedResponseOptions: null,
  ...over,
});

describe("context builder", () => {
  it("computes the refundable balance from refunds (PayPal's capture GET does not give it)", () => {
    expect(buildContext(facts()).refundableMinor).toBe(3800);
    expect(buildContext(facts({ captureRefunds: [{ amountMinor: 1000 }, { amountMinor: 800 }] })).refundableMinor).toBe(2000);
  });

  it("never reports a negative balance", () => {
    expect(buildContext(facts({ captureRefunds: [{ amountMinor: 5000 }] })).refundableMinor).toBe(0);
  });

  it("counts only Countersign refunds from today (UTC) toward the daily total", () => {
    const ctx = buildContext(
      facts({
        merchantRefunds: [
          { amountMinor: 1000, createdAt: new Date("2026-11-10T00:00:00Z"), origin: "countersign" }, // counts (start of day)
          { amountMinor: 500, createdAt: new Date("2026-11-09T23:59:59Z"), origin: "countersign" }, // yesterday
          { amountMinor: 700, createdAt: new Date("2026-11-10T08:00:00Z"), origin: "external" }, // not ours
        ],
      }),
    );
    expect(ctx.refundsTodayMinor).toBe(1000);
  });

  it("uses a 90-day window for buyer history, boundary inclusive, future rows excluded", () => {
    const ctx = buildContext(
      facts({
        buyerRefunds: [
          { amountMinor: 100, createdAt: daysAgo(90), origin: "countersign" }, // exactly 90d: in
          { amountMinor: 200, createdAt: new Date(daysAgo(90).getTime() - 1), origin: "external" }, // just outside
          { amountMinor: 400, createdAt: daysAgo(5), origin: "external" },
          { amountMinor: 800, createdAt: new Date(NOW.getTime() + 1000), origin: "external" }, // clock skew / bad data
        ],
      }),
    );
    expect(ctx.buyerRefunds90dCount).toBe(2);
    expect(ctx.buyerRefunds90dMinor).toBe(500);
  });

  it("counts whole days since delivery, and reports unknown as null", () => {
    expect(buildContext(facts()).daysSinceDelivery).toBe(10);
    expect(buildContext(facts({ order: { amountMinor: 3800, currency: "USD", deliveredAt: null } })).daysSinceDelivery).toBeNull();
    expect(buildContext(facts({ order: { amountMinor: 3800, currency: "USD", deliveredAt: new Date(NOW.getTime() + 1000) } })).daysSinceDelivery).toBeNull();
  });

  it("passes dispute facts through unchanged", () => {
    const ctx = buildContext(facts({ disputeStage: "INQUIRY", allowedResponseOptions: ["ACCEPT_CLAIM"] }));
    expect(ctx.disputeStage).toBe("INQUIRY");
    expect(ctx.allowedResponseOptions).toEqual(["ACCEPT_CLAIM"]);
  });
});
