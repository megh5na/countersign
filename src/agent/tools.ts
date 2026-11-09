// The agent's read-only tools and the handle registry (invariants I1, I2).
// Tools return facts for the model to reason about, but every identifier is swapped for an opaque handle (h_1, h_2...).
// The model can only cite handles; the server maps them back. There is no write tool and no amount field anywhere.

import { minorToDecimal } from "../money.js";

type Kind = "order" | "capture" | "buyer";

export class HandleRegistry {
  private byHandle = new Map<string, { kind: Kind; id: string }>();
  private byKey = new Map<string, string>();
  private n = 0;

  issue(kind: Kind, id: string): string {
    const key = `${kind}:${id}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const handle = `h_${++this.n}`;
    this.byHandle.set(handle, { kind, id });
    this.byKey.set(key, handle);
    return handle;
  }

  resolve(handle: unknown, kind: Kind): string | undefined {
    if (typeof handle !== "string") return undefined;
    const hit = this.byHandle.get(handle);
    return hit && hit.kind === kind ? hit.id : undefined;
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.byHandle].map(([h, v]) => [h, `${v.kind}:${v.id}`]));
  }
}

// What the tools may read. Implemented over Postgres in production, and by a fake in tests.
export interface AgentData {
  getOrder(orderId: string): Promise<
    { id: string; amountMinor: number; currency: string; captureId: string | null; payerId: string | null; deliveredAt: Date | null; trackingNo: string | null } | undefined
  >;
  refundsForCapture(captureId: string): Promise<{ amountMinor: number; createdAt: Date; origin: string }[]>;
  buyerHistory(payerId: string, now: Date): Promise<{ refundCount90d: number; refundMinor90d: number; orderCount: number }>;
}

export interface ToolContext {
  caseOrderId: string; // the ONE order this case is about; tools can never look at another
  data: AgentData;
  handles: HandleRegistry;
  now: Date;
}

export type ToolResult = { ok: true; value: unknown } | { ok: false; error: string };

interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: readonly string[]; additionalProperties: false };
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const money = (minor: number) => minorToDecimal(minor);
const daysAgo = (d: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
const noArgs = { type: "object", properties: {}, required: [], additionalProperties: false } as const;
const handleArg = (what: string) => ({ type: "object", properties: { handle: { type: "string", description: what } }, required: ["handle"], additionalProperties: false }) as const;

export const READ_TOOLS: ToolSpec[] = [
  {
    name: "get_order",
    description: "Facts about the order this case is about: total, currency, whether payment was captured, how many days ago it was delivered (null if unknown), and whether tracking is on file. Returns an order handle.",
    input_schema: noArgs,
    async run(_in, c) {
      const o = await c.data.getOrder(c.caseOrderId);
      if (!o) return { ok: false, error: "order not found" };
      return {
        ok: true,
        value: {
          order_handle: c.handles.issue("order", o.id),
          total: money(o.amountMinor),
          currency: o.currency,
          payment_captured: o.captureId !== null,
          delivered_days_ago: o.deliveredAt ? daysAgo(o.deliveredAt, c.now) : null,
          tracking_on_file: o.trackingNo !== null,
        },
      };
    },
  },
  {
    name: "get_capture",
    description: "The captured payment for an order handle: amount, how much has already been refunded, and what remains refundable. Returns the capture handle you must cite in propose_remedy.",
    input_schema: handleArg("an order handle returned by get_order"),
    async run(input, c) {
      const orderId = c.handles.resolve(input.handle, "order");
      if (!orderId) return { ok: false, error: "unknown order handle" };
      const o = await c.data.getOrder(orderId);
      if (!o?.captureId) return { ok: false, error: "this order has no captured payment" };
      const refunded = (await c.data.refundsForCapture(o.captureId)).reduce((s, r) => s + r.amountMinor, 0);
      return {
        ok: true,
        value: {
          capture_handle: c.handles.issue("capture", o.id), // resolves to OUR order row; the executor finds the PayPal capture itself
          amount: money(o.amountMinor),
          currency: o.currency,
          already_refunded: money(refunded),
          refundable_remaining: money(Math.max(0, o.amountMinor - refunded)),
        },
      };
    },
  },
  {
    name: "list_refunds",
    description: "Refunds already issued against a capture handle (amount, days ago, whether Countersign or someone else issued it).",
    input_schema: handleArg("a capture handle returned by get_capture"),
    async run(input, c) {
      const orderId = c.handles.resolve(input.handle, "capture");
      if (!orderId) return { ok: false, error: "unknown capture handle" };
      const o = await c.data.getOrder(orderId);
      if (!o?.captureId) return { ok: false, error: "no captured payment" };
      const rows = await c.data.refundsForCapture(o.captureId);
      return { ok: true, value: { refunds: rows.map((r) => ({ amount: money(r.amountMinor), days_ago: daysAgo(r.createdAt, c.now), issued_by: r.origin })) } };
    },
  },
  {
    name: "get_buyer_history",
    description: "How many orders this buyer has placed and how many refunds (and how much) they received in the last 90 days.",
    input_schema: noArgs,
    async run(_in, c) {
      const o = await c.data.getOrder(c.caseOrderId);
      if (!o) return { ok: false, error: "order not found" };
      if (!o.payerId) return { ok: true, value: { buyer_known: false } };
      const h = await c.data.buyerHistory(o.payerId, c.now);
      return {
        ok: true,
        value: { buyer_handle: c.handles.issue("buyer", o.payerId), buyer_known: true, orders_total: h.orderCount, refunds_last_90_days: h.refundCount90d, refunded_last_90_days: money(h.refundMinor90d) },
      };
    },
  },
];

// The only way to finish. There is deliberately no amount, no PayPal id, and no free-form action in it.
export const PROPOSE_TOOL = {
  name: "propose_remedy",
  description:
    "Finish the case by proposing a remedy. You choose the claim type and a remedy tier; the system decides whether it is allowed and how much money moves. Cite the tool calls that support your choice.",
  input_schema: {
    type: "object",
    properties: {
      claim_type: { type: "string", enum: ["damaged", "not_received", "not_as_described", "changed_mind", "other"] },
      remedy: { type: "string", enum: ["full_refund", "partial_tier_a", "partial_tier_b", "replacement_offer", "explain_no_refund", "escalate"] },
      capture_handle: { type: "string", description: "the capture handle from get_capture" },
      buyer_message_draft: { type: "string", description: "a short, polite reply to the buyer (no amounts, no promises of money)" },
      rationale: { type: "string", description: "why you chose this, for the merchant's timeline" },
      cited_tool_calls: { type: "array", items: { type: "string" }, description: "ids of the tool calls you relied on, e.g. tc_1" },
    },
    required: ["claim_type", "remedy", "capture_handle", "buyer_message_draft", "rationale", "cited_tool_calls"],
    additionalProperties: false,
  },
} as const;

export const toolDefinitions = () =>
  [...READ_TOOLS.map(({ name, description, input_schema }) => ({ name, description, strict: true, input_schema })), { ...PROPOSE_TOOL, strict: true }];
