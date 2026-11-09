// The demo policy: the one the evaluation suite (evals/) is graded against, and the one `npm run seed` installs.
// Keeping a single definition means the policy we demo is exactly the policy we tested.

import { Policy } from "./schema.js";

const MONEY = ["full_refund", "partial_tier_a", "partial_tier_b"] as const;
const rule = (id: string, effect: string, remedy: string, when: object, amount?: object) => ({ id, effect, remedy, when, ...(amount ? { amount } : {}) });

export const DEMO_POLICY_TEXT =
  "Damaged or not-as-described items reported within 30 days of delivery, on orders of $75 or less: refund 50%. Orders above $75 always need my approval. Nothing is refunded more than 90 days after delivery. No refunds for changed minds. No single buyer gets more than $30 auto-refunded in 90 days.";

export const DEMO_POLICY = Policy.parse({
  currency: "USD",
  rules: [
    rule("R1", "allow", "partial_tier_a", { claim_type_in: ["damaged", "not_as_described"], days_since_delivery_lte: 30, order_total_minor_lte: 7500 }, { percent_of_capture: 50 }),
    ...MONEY.map((m, i) => rule(`R${2 + i}`, "require_approval", m, { order_total_minor_gte: 7501 })),
    ...MONEY.map((m, i) => rule(`R${5 + i}`, "deny", m, { days_since_delivery_gte: 91 })),
    ...MONEY.map((m, i) => rule(`R${8 + i}`, "deny", m, { claim_type_in: ["changed_mind"] })),
  ],
  limits: { buyer_90d_cap_minor: 3000 },
});
