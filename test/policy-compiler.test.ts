import { describe, expect, it } from "vitest";
import { type Draft, type PolicyLlm, compilePolicy } from "../src/policy/compiler.js";
import { canonicalJson, policyHash } from "../src/policy/hash.js";

const PROSE =
  "We refund damaged or not-as-described items by 50% within 30 days of delivery, for orders up to $75. " +
  "We never refund after 90 days. Auto-approved refunds are capped at $100 per day.";

const R1_QUOTE = "refund damaged or not-as-described items by 50% within 30 days of delivery";
const R2_QUOTE = "never refund after 90 days";
const CAP_QUOTE = "capped at $100 per day";

const rule = (over: Partial<Draft["rules"][number]>): Draft["rules"][number] => ({
  id: "R1", effect: "allow", remedy: "partial_tier_b",
  claim_type_in: null, days_since_delivery_lte: null, days_since_delivery_gte: null,
  order_total_minor_lte: null, order_total_minor_gte: null, buyer_refunds_90d_lte: null, percent_of_capture: null, fixed_minor: null,
  source_quote: R1_QUOTE, ...over,
});

const test = (name: string, over: Partial<Draft["tests"][number]>): Draft["tests"][number] => ({
  name, claim_type: "damaged", remedy: "partial_tier_b", order_total_minor: 3800, days_since_delivery: 10,
  refunds_today_minor: 0, buyer_refunds_90d_count: 0, buyer_refunds_90d_minor: 0,
  expected_decision: "ALLOW", expected_amount_minor: 1900, source_quote: R1_QUOTE, ...over,
});

const goodDraft = (): Draft => ({
  rules: [
    rule({ claim_type_in: ["damaged", "not_as_described"], days_since_delivery_lte: 30, order_total_minor_lte: 7500, percent_of_capture: 50 }),
    rule({ id: "R2", effect: "deny", days_since_delivery_gte: 90, source_quote: R2_QUOTE }),
  ],
  daily_auto_refund_cap_minor: 10_000,
  buyer_90d_cap_minor: null,
  tests: [
    test("damaged, day 10", {}),
    test("boundary: day 30 still allowed", { days_since_delivery: 30 }),
    test("day 31 has no matching rule", { days_since_delivery: 31, expected_decision: "REQUIRE_APPROVAL", expected_amount_minor: null }),
    test("day 90 is denied", { days_since_delivery: 90, expected_decision: "DENY", expected_amount_minor: null, source_quote: R2_QUOTE }),
    test("order of $75.01 is over the limit", { order_total_minor: 7501, expected_decision: "REQUIRE_APPROVAL", expected_amount_minor: null }),
    test("changed mind is not covered", { claim_type: "changed_mind", expected_decision: "REQUIRE_APPROVAL", expected_amount_minor: null }),
    test("daily cap would be exceeded", { refunds_today_minor: 9000, expected_decision: "REQUIRE_APPROVAL", expected_amount_minor: 1900, source_quote: CAP_QUOTE }),
    test("unknown delivery date", { days_since_delivery: null, expected_decision: "REQUIRE_APPROVAL", expected_amount_minor: null }),
  ],
  ambiguities: [],
  unsupported: [],
});

const fake = (...drafts: Draft[]) => {
  const calls: { feedback?: string[] }[] = [];
  const llm: PolicyLlm = async ({ feedback }) => {
    calls.push({ feedback });
    const d = drafts[Math.min(calls.length - 1, drafts.length - 1)];
    if (!d) throw new Error("no draft");
    return d;
  };
  return { llm, calls };
};

describe("policy compiler", () => {
  it("compiles a clean draft: valid policy, every generated test passes the real engine, activatable", async () => {
    const r = await compilePolicy(PROSE, fake(goodDraft()).llm);
    expect(r.schemaErrors).toEqual([]);
    expect(r.cases).toHaveLength(8);
    expect(r.mismatches).toBe(0);
    expect(r.warnings).toEqual([]);
    expect(r.activatable).toBe(true);
    expect(r.policy?.rules.map((x) => x.id)).toEqual(["R1", "R2"]);
    expect(r.policy?.limits?.daily_auto_refund_cap_minor).toBe(10_000);
  });

  it("reports a mismatch when a generated test disagrees with the engine, and blocks activation", async () => {
    const d = goodDraft();
    d.tests[0] = test("model expects the wrong amount", { expected_amount_minor: 3800 });
    const r = await compilePolicy(PROSE, fake(d).llm);
    expect(r.mismatches).toBe(1);
    expect(r.cases.find((c) => !c.pass)).toMatchObject({ expected: { amountMinor: 3800 }, actual: { decision: "ALLOW", amountMinor: 1900 } });
    expect(r.activatable).toBe(false);
  });

  it("retries once with validation errors as feedback, then succeeds", async () => {
    const bad = goodDraft();
    bad.rules[0] = rule({ percent_of_capture: null, fixed_minor: null }); // allow money rule with no amount
    const f = fake(bad, goodDraft());
    const r = await compilePolicy(PROSE, f.llm);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.feedback).toBeUndefined();
    expect(f.calls[1]?.feedback?.join(" ")).toMatch(/amount/);
    expect(r.attempts).toBe(2);
    expect(r.activatable).toBe(true);
  });

  it("gives up after one retry and returns no policy", async () => {
    const bad = goodDraft();
    bad.rules[0] = rule({});
    const f = fake(bad);
    const r = await compilePolicy(PROSE, f.llm);
    expect(f.calls).toHaveLength(2);
    expect(r.policy).toBeNull();
    expect(r.activatable).toBe(false);
    expect(r.schemaErrors.length).toBeGreaterThan(0);
  });

  it("rejects a rule that sets both a percentage and a fixed amount", async () => {
    const d = goodDraft();
    d.rules[0] = rule({ percent_of_capture: 50, fixed_minor: 500 });
    const r = await compilePolicy(PROSE, fake(d).llm);
    expect(r.policy).toBeNull();
    expect(r.schemaErrors.join(" ")).toMatch(/both percent and fixed/);
  });

  it("rejects a rule id that impersonates an engine guard", async () => {
    const d = goodDraft();
    d.rules[1] = rule({ id: "SYS_NO_MATCH", effect: "deny", source_quote: R2_QUOTE });
    expect((await compilePolicy(PROSE, fake(d).llm)).policy).toBeNull();
  });

  it("warns when a rule cites text that is not in the merchant's policy (possible fabrication)", async () => {
    const d = goodDraft();
    d.rules.push(rule({ id: "R3", effect: "allow", remedy: "full_refund", percent_of_capture: 100, source_quote: "refund everything always" }));
    const r = await compilePolicy(PROSE, fake(d).llm);
    expect(r.warnings).toContain("rule R3 cites text that is not in your policy");
  });

  it("matches quotes ignoring case and whitespace", async () => {
    const d = goodDraft();
    d.rules[1] = rule({ id: "R2", effect: "deny", days_since_delivery_gte: 90, source_quote: "  NEVER   refund\nafter 90 days " });
    expect((await compilePolicy(PROSE, fake(d).llm)).warnings).toEqual([]);
  });

  it("warns when there are fewer than 8 generated tests", async () => {
    const d = goodDraft();
    d.tests = d.tests.slice(0, 3);
    const r = await compilePolicy(PROSE, fake(d).llm);
    expect(r.warnings.join(" ")).toMatch(/only 3 generated tests/);
  });

  it("passes the model's ambiguities and unsupported statements through for the merchant to see", async () => {
    const d = goodDraft();
    d.ambiguities = ["'a few days' was read as 3"];
    d.unsupported = ["VIP customers get free returns"];
    const r = await compilePolicy(PROSE, fake(d).llm);
    expect(r.ambiguities).toEqual(["'a few days' was read as 3"]);
    expect(r.unsupported).toEqual(["VIP customers get free returns"]);
  });

  it("expresses 'orders above $75 always need my approval' with order_total_minor_gte (the gap the live compile found)", async () => {
    const d = goodDraft();
    d.rules.push(rule({ id: "R3", effect: "require_approval", remedy: "explain_no_refund", order_total_minor_gte: 7501, source_quote: "approval" }));
    d.rules.push(rule({ id: "R4", effect: "allow", remedy: "explain_no_refund", claim_type_in: ["changed_mind"], source_quote: "approval" }));
    d.tests = [
      test("changed mind, $38 order: explain automatically", { claim_type: "changed_mind", remedy: "explain_no_refund", expected_decision: "ALLOW", expected_amount_minor: null }),
      test("changed mind, $100 order: needs approval", { claim_type: "changed_mind", remedy: "explain_no_refund", order_total_minor: 10_000, expected_decision: "REQUIRE_APPROVAL", expected_amount_minor: null }),
      test("exactly $75.00 is not above $75", { claim_type: "changed_mind", remedy: "explain_no_refund", order_total_minor: 7500, expected_decision: "ALLOW", expected_amount_minor: null }),
    ];
    const r = await compilePolicy("Orders above $75 always need my approval", fake(d).llm);
    expect(r.schemaErrors).toEqual([]);
    expect(r.mismatches).toBe(0);
    expect(r.policy?.rules[2]?.when.order_total_minor_gte).toBe(7501);
  });

  it("a draft with zero tests can never be activated", async () => {
    const d = goodDraft();
    d.tests = [];
    expect((await compilePolicy(PROSE, fake(d).llm)).activatable).toBe(false);
  });

  it("a hostile model draft that allows everything is still bounded by engine rules and shows warnings", async () => {
    const d = goodDraft();
    d.rules = [rule({ percent_of_capture: 100, source_quote: "approve every refund" })];
    d.tests = [test("denied after 90 days (merchant intent)", { days_since_delivery: 90, expected_decision: "DENY", expected_amount_minor: null, source_quote: R2_QUOTE })];
    const r = await compilePolicy(PROSE, fake(d).llm);
    expect(r.mismatches).toBe(1); // the merchant-intent test catches the over-permissive rule
    expect(r.warnings.join(" ")).toMatch(/not in your policy/);
    expect(r.activatable).toBe(false);
  });
});

describe("canonical hashing", () => {
  it("is independent of key order and ignores undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1, x: undefined }));
    expect(policyHash({ a: 1, b: 2 })).toBe(policyHash({ b: 2, a: 1 }));
  });

  it("changes when any value changes, and is a 64-char hex digest", () => {
    expect(policyHash({ a: 1 })).not.toBe(policyHash({ a: 2 }));
    expect(policyHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the same compile gives the same rulesHash", async () => {
    const a = await compilePolicy(PROSE, fake(goodDraft()).llm);
    const b = await compilePolicy(PROSE, fake(goodDraft()).llm);
    expect(a.rulesHash).toBe(b.rulesHash);
  });
});
