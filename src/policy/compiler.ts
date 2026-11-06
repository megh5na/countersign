// Policy compiler: merchant prose -> validated Policy + generated test cases + a report.
// The model only DRAFTS. Every draft is re-validated by our own Zod schema, and the generated tests
// are run through the real engine. Nothing is activated here; a human confirms (Day 7 UI).

import { z } from "zod";
import type { Context } from "./context.js";
import { evaluate } from "./engine.js";
import { policyHash } from "./hash.js";
import { ClaimType, Policy, Remedy } from "./schema.js";

// ---- What the model is asked to produce (structured output). Flat and nullable: every key present. ----
const Int = z.number().int();

export const DraftRule = z.object({
  id: z.string(),
  effect: z.enum(["allow", "require_approval", "deny"]),
  remedy: Remedy,
  claim_type_in: z.array(ClaimType).nullable(),
  days_since_delivery_lte: Int.nullable(),
  days_since_delivery_gte: Int.nullable(),
  order_total_minor_lte: Int.nullable(),
  order_total_minor_gte: Int.nullable(),
  buyer_refunds_90d_lte: Int.nullable(),
  percent_of_capture: Int.nullable(),
  fixed_minor: Int.nullable(),
  source_quote: z.string(), // the sentence of the merchant's policy this rule came from
});

export const DraftTest = z.object({
  name: z.string(),
  claim_type: ClaimType,
  remedy: Remedy,
  order_total_minor: Int,
  days_since_delivery: Int.nullable(),
  refunds_today_minor: Int,
  buyer_refunds_90d_count: Int,
  buyer_refunds_90d_minor: Int,
  expected_decision: z.enum(["ALLOW", "REQUIRE_APPROVAL", "DENY"]),
  expected_amount_minor: Int.nullable(), // null = amount not checked
  source_quote: z.string(),
});

export const Draft = z.object({
  rules: z.array(DraftRule),
  daily_auto_refund_cap_minor: Int.nullable(),
  buyer_90d_cap_minor: Int.nullable(),
  tests: z.array(DraftTest),
  ambiguities: z.array(z.string()), // places where the prose was unclear and the model had to guess
  unsupported: z.array(z.string()), // statements the rule language cannot express
});
export type Draft = z.infer<typeof Draft>;

export type PolicyLlm = (input: { prose: string; feedback?: string[] }) => Promise<Draft>;

// ---- Draft -> candidate Policy (deterministic) ----
function toPolicy(d: Draft): { candidate: unknown; errors: string[] } {
  const errors: string[] = [];
  const rules = d.rules.map((r) => {
    const when: Record<string, unknown> = {};
    if (r.claim_type_in !== null) when.claim_type_in = r.claim_type_in;
    if (r.days_since_delivery_lte !== null) when.days_since_delivery_lte = r.days_since_delivery_lte;
    if (r.days_since_delivery_gte !== null) when.days_since_delivery_gte = r.days_since_delivery_gte;
    if (r.order_total_minor_lte !== null) when.order_total_minor_lte = r.order_total_minor_lte;
    if (r.order_total_minor_gte !== null) when.order_total_minor_gte = r.order_total_minor_gte;
    if (r.buyer_refunds_90d_lte !== null) when.buyer_refunds_90d_lte = r.buyer_refunds_90d_lte;

    let amount: unknown;
    if (r.percent_of_capture !== null && r.fixed_minor !== null) errors.push(`rule ${r.id}: both percent and fixed amount given`);
    else if (r.percent_of_capture !== null) amount = { percent_of_capture: r.percent_of_capture };
    else if (r.fixed_minor !== null) amount = { fixed_minor: r.fixed_minor };

    return { id: r.id, effect: r.effect, remedy: r.remedy, when, ...(amount ? { amount } : {}) };
  });

  const limits: Record<string, number> = {};
  if (d.daily_auto_refund_cap_minor !== null) limits.daily_auto_refund_cap_minor = d.daily_auto_refund_cap_minor;
  if (d.buyer_90d_cap_minor !== null) limits.buyer_90d_cap_minor = d.buyer_90d_cap_minor;

  return { candidate: { currency: "USD", rules, ...(Object.keys(limits).length ? { limits } : {}) }, errors };
}

// ---- Generated tests, run through the REAL engine ----
export interface CaseResult {
  name: string;
  pass: boolean;
  expected: { decision: string; amountMinor: number | null };
  actual: { decision: string; amountMinor: number | null; ruleIds: string[] };
}

function runTests(policy: Policy, tests: Draft["tests"]): CaseResult[] {
  return tests.map((t) => {
    const ctx: Context = {
      currency: "USD",
      captureAmountMinor: t.order_total_minor,
      orderTotalMinor: t.order_total_minor,
      refundableMinor: t.order_total_minor,
      refundsTodayMinor: t.refunds_today_minor,
      buyerRefunds90dCount: t.buyer_refunds_90d_count,
      buyerRefunds90dMinor: t.buyer_refunds_90d_minor,
      daysSinceDelivery: t.days_since_delivery,
      disputeStage: null,
      allowedResponseOptions: null,
    };
    const r = evaluate({ claimType: t.claim_type, remedy: t.remedy }, ctx, policy);
    const amountOk = t.expected_amount_minor === null || r.amountMinor === t.expected_amount_minor;
    return {
      name: t.name,
      pass: r.decision === t.expected_decision && amountOk,
      expected: { decision: t.expected_decision, amountMinor: t.expected_amount_minor },
      actual: { decision: r.decision, amountMinor: r.amountMinor, ruleIds: r.ruleIds },
    };
  });
}

// ---- Provenance: a quoted source sentence must really appear in the merchant's text ----
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function provenanceWarnings(prose: string, d: Draft): string[] {
  const haystack = norm(prose);
  const missing = (q: string) => norm(q).length === 0 || !haystack.includes(norm(q));
  return [
    ...d.rules.filter((r) => missing(r.source_quote)).map((r) => `rule ${r.id} cites text that is not in your policy`),
    ...d.tests.filter((t) => missing(t.source_quote)).map((t) => `test "${t.name}" cites text that is not in your policy`),
  ];
}

export interface CompileReport {
  policy: Policy | null;
  rulesHash: string | null;
  schemaErrors: string[];
  cases: CaseResult[];
  mismatches: number;
  warnings: string[];
  ambiguities: string[];
  unsupported: string[];
  attempts: number;
  activatable: boolean; // valid policy AND every generated test agrees with the engine
}

const MIN_TESTS = 8;

export async function compilePolicy(prose: string, llm: PolicyLlm): Promise<CompileReport> {
  let feedback: string[] | undefined;
  let last: CompileReport | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const draft = await llm({ prose, feedback });
    const { candidate, errors } = toPolicy(draft);
    const parsed = Policy.safeParse(candidate);
    const schemaErrors = [...errors, ...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`))];

    const warnings = provenanceWarnings(prose, draft);
    if (draft.tests.length < MIN_TESTS) warnings.push(`only ${draft.tests.length} generated tests (expected at least ${MIN_TESTS})`);

    if (parsed.success && errors.length === 0) {
      const cases = runTests(parsed.data, draft.tests);
      const mismatches = cases.filter((c) => !c.pass).length;
      return {
        policy: parsed.data,
        rulesHash: policyHash(parsed.data),
        schemaErrors: [],
        cases,
        mismatches,
        warnings,
        ambiguities: draft.ambiguities,
        unsupported: draft.unsupported,
        attempts: attempt,
        activatable: mismatches === 0 && draft.tests.length > 0,
      };
    }

    last = {
      policy: null, rulesHash: null, schemaErrors, cases: [], mismatches: 0, warnings,
      ambiguities: draft.ambiguities, unsupported: draft.unsupported, attempts: attempt, activatable: false,
    };
    feedback = schemaErrors; // one retry, telling the model exactly what failed validation
  }
  return last as CompileReport;
}
