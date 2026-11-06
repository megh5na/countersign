// The policy DSL: what a merchant's rules look like once compiled into data.
// Strict objects everywhere: an unknown key is an error, never silently ignored.

import { z } from "zod";

export const ClaimType = z.enum(["damaged", "not_received", "not_as_described", "changed_mind", "other"]);
export type ClaimType = z.infer<typeof ClaimType>;

export const Remedy = z.enum([
  "full_refund",
  "partial_tier_a",
  "partial_tier_b",
  "replacement_offer",
  "explain_no_refund",
  "escalate",
]);
export type Remedy = z.infer<typeof Remedy>;

// Remedies that move money. Only these may carry an amount and only these hit the balance and caps.
export const MONEY_REMEDIES: readonly Remedy[] = ["full_refund", "partial_tier_a", "partial_tier_b"];
export const movesMoney = (r: Remedy) => MONEY_REMEDIES.includes(r);

const Minor = z.number().int().nonnegative();

// Every condition is optional; all that are present must hold (AND). Empty `when` always matches.
const When = z.strictObject({
  claim_type_in: z.array(ClaimType).min(1).optional(),
  days_since_delivery_lte: Minor.optional(),
  days_since_delivery_gte: Minor.optional(),
  order_total_minor_lte: Minor.optional(),
  buyer_refunds_90d_lte: Minor.optional(), // count of refunds, not money
});
export type When = z.infer<typeof When>;

const Amount = z.union([
  z.strictObject({ percent_of_capture: z.number().int().min(0).max(100) }),
  z.strictObject({ fixed_minor: Minor }),
]);
export type Amount = z.infer<typeof Amount>;

export const Rule = z
  .strictObject({
    id: z.string().min(1),
    effect: z.enum(["allow", "require_approval", "deny"]),
    remedy: Remedy,
    when: When,
    amount: Amount.optional(),
  })
  .refine((r) => !(r.effect === "allow" && movesMoney(r.remedy)) || r.amount !== undefined, {
    message: "an allow rule for a money-moving remedy must state an amount",
    path: ["amount"],
  })
  .refine((r) => movesMoney(r.remedy) || r.amount === undefined, {
    message: "only money-moving remedies may carry an amount",
    path: ["amount"],
  });
export type Rule = z.infer<typeof Rule>;

// Global cumulative limits, evaluated on every proposal (defends against split refunds).
const Limits = z.strictObject({
  daily_auto_refund_cap_minor: Minor.optional(),
  buyer_90d_cap_minor: Minor.optional(),
});

export const Policy = z
  .strictObject({
    currency: z.literal("USD"), // caps are summed in minor units, so one currency per policy
    rules: z.array(Rule),
    limits: Limits.optional(),
  })
  .refine((p) => new Set(p.rules.map((r) => r.id)).size === p.rules.length, { message: "rule ids must be unique", path: ["rules"] })
  .refine((p) => p.rules.every((r) => !/^(SYS|LIMIT)_/.test(r.id)), {
    message: "rule ids may not start with SYS_ or LIMIT_ (reserved for the engine)",
    path: ["rules"],
  });
export type Policy = z.infer<typeof Policy>;
