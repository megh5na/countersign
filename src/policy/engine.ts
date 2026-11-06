// The policy engine (invariants I3, I4, I5). Pure: no I/O, no clock, no model.
// The Proposal type has no `rationale` field, so the model's free text cannot influence a decision.

import type { Context } from "./context.js";
import { type Amount, type ClaimType, type Policy, type Remedy, type Rule, movesMoney } from "./schema.js";

export interface Proposal {
  claimType: ClaimType;
  remedy: Remedy;
}

export type DecisionKind = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

export interface Decision {
  decision: DecisionKind;
  amountMinor: number | null; // only for money-moving remedies; already capped at the refundable balance
  ruleIds: string[]; // rules and engine guards (SYS_*, LIMIT_*) that produced this decision
  reasons: string[]; // human-readable, for the case timeline
}

function matches(rule: Rule, p: Proposal, ctx: Context): boolean {
  if (rule.remedy !== p.remedy) return false;
  const w = rule.when;
  if (w.claim_type_in && !w.claim_type_in.includes(p.claimType)) return false;
  if (w.order_total_minor_lte !== undefined && ctx.orderTotalMinor > w.order_total_minor_lte) return false;
  if (w.order_total_minor_gte !== undefined && ctx.orderTotalMinor < w.order_total_minor_gte) return false;
  if (w.buyer_refunds_90d_lte !== undefined && ctx.buyerRefunds90dCount > w.buyer_refunds_90d_lte) return false;
  // Unknown delivery date: these conditions do not match, so an allow rule cannot fire on missing data.
  if (w.days_since_delivery_lte !== undefined && (ctx.daysSinceDelivery === null || ctx.daysSinceDelivery > w.days_since_delivery_lte)) return false;
  if (w.days_since_delivery_gte !== undefined && (ctx.daysSinceDelivery === null || ctx.daysSinceDelivery < w.days_since_delivery_gte)) return false;
  return true;
}

function amountOf(a: Amount, ctx: Context): number {
  // Integer math only; floor so rounding never favours the buyer.
  return "percent_of_capture" in a ? Math.floor((ctx.captureAmountMinor * a.percent_of_capture) / 100) : a.fixed_minor;
}

// Most conservative amount among the rules that apply.
function lowestAmount(rules: Rule[], ctx: Context): number | null {
  const amounts = rules.flatMap((r) => (r.amount ? [amountOf(r.amount, ctx)] : []));
  return amounts.length ? Math.min(...amounts) : null;
}

export function evaluate(proposal: Proposal, ctx: Context, policy: Policy): Decision {
  const money = movesMoney(proposal.remedy);
  const hits = policy.rules.filter((r) => matches(r, proposal, ctx));
  const denies = hits.filter((r) => r.effect === "deny");
  const asks = hits.filter((r) => r.effect === "require_approval");
  const allows = hits.filter((r) => r.effect === "allow");

  // I4: DENY > REQUIRE_APPROVAL > ALLOW. A refund with nothing left to refund is denied outright.
  if (denies.length > 0) {
    return { decision: "DENY", amountMinor: null, ruleIds: denies.map((r) => r.id), reasons: ["a deny rule matched"] };
  }
  if (money && ctx.refundableMinor <= 0) {
    return { decision: "DENY", amountMinor: null, ruleIds: ["SYS_NO_BALANCE"], reasons: ["nothing left to refund on this capture"] };
  }

  let decision: DecisionKind;
  let ruleIds: string[];
  const reasons: string[] = [];
  let amount: number | null;

  if (asks.length > 0) {
    decision = "REQUIRE_APPROVAL";
    ruleIds = asks.map((r) => r.id);
    amount = lowestAmount([...asks, ...allows], ctx);
    reasons.push("a rule requires approval");
  } else if (allows.length > 0) {
    decision = "ALLOW";
    ruleIds = allows.map((r) => r.id);
    amount = lowestAmount(allows, ctx);
  } else {
    // I4: no matching rule means a human decides.
    return { decision: "REQUIRE_APPROVAL", amountMinor: null, ruleIds: ["SYS_NO_MATCH"], reasons: ["no rule matched this proposal"] };
  }

  // I5: executed amount = min(rule amount, remaining refundable balance).
  if (money && amount !== null && amount > ctx.refundableMinor) {
    amount = ctx.refundableMinor;
    reasons.push("amount capped at the refundable balance");
  }
  if (!money) amount = null;

  // Guards can only make an ALLOW stricter. They never loosen anything.
  if (decision === "ALLOW" && money) {
    const downgrade = (id: string, why: string) => {
      decision = "REQUIRE_APPROVAL";
      ruleIds = [...ruleIds, id];
      reasons.push(why);
    };
    if (amount === null) downgrade("SYS_NO_AMOUNT", "no amount could be computed");
    else if (amount <= 0) downgrade("SYS_ZERO_AMOUNT", "the computed refund is $0 (check the rule's amount)");
    else {
      if (ctx.currency !== policy.currency) downgrade("SYS_CURRENCY", "capture currency differs from the policy currency");
      const daily = policy.limits?.daily_auto_refund_cap_minor;
      if (daily !== undefined && ctx.refundsTodayMinor + amount > daily) downgrade("LIMIT_DAILY", "daily auto-refund cap would be exceeded");
      const buyer = policy.limits?.buyer_90d_cap_minor;
      if (buyer !== undefined && ctx.buyerRefunds90dMinor + amount > buyer) downgrade("LIMIT_BUYER_90D", "per-buyer 90-day cap would be exceeded");
    }
  }

  return { decision, amountMinor: amount, ruleIds, reasons };
}
