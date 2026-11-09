// Admin guard shared by every non-public route, plus the admin-only case endpoints.
// Without ADMIN_TOKEN configured, all of it answers 503: nothing is ever open by accident.

import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ApprovalRepo } from "../db/approvals.js";
import type { CaseRepo } from "../db/cases.js";
import type { DemoRepo } from "../db/demo.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

export type Role = "admin" | "judge";
export type AuthEnv = { Variables: { role: Role } };

// Two secrets: the admin token can do everything; the optional judge token is read-only. The read-only rule lives here,
// in the guard, so no route can forget it: a judge gets 403 on anything except GET/HEAD.
export function requireAdmin(adminToken?: string, judgeToken?: string): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!adminToken) return c.json({ error: "admin_not_configured" }, 503);
    const h = c.req.header("authorization");
    const given = digest(h?.startsWith("Bearer ") ? h.slice(7) : "");
    // Fixed-length digests, and both comparisons always run, so timing reveals nothing about either token.
    const isAdmin = timingSafeEqual(given, digest(adminToken));
    const isJudge = judgeToken ? timingSafeEqual(given, digest(judgeToken)) : false;
    if (!isAdmin && !isJudge) return c.json({ error: "unauthorized" }, 401);
    const role: Role = isAdmin ? "admin" : "judge";
    if (role === "judge" && c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "read_only" }, 403);
    c.set("role", role);
    await next();
  };
}

const Delivered = z.object({ daysAgo: z.number().int().min(0).max(365) });
const Approve = z.object({ paramsHash: z.string().length(64), amountMinor: z.number().int().positive().max(10_000_000).optional() });
const Reject = z.object({ paramsHash: z.string().length(64) });
const Resolve = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refund"), remedy: z.enum(["full_refund", "partial_tier_a", "partial_tier_b"]), amountMinor: z.number().int().positive().max(10_000_000) }),
  z.object({ action: z.literal("decline") }),
]);
const RESOLVE_ERRORS = { not_found: 404, not_resolvable: 409, no_agent_run: 422, no_policy: 422, order_not_ready: 422, exceeds_refundable: 422 } as const;

const APPROVE_ERRORS = { not_found: 404, not_pending: 409, expired: 410, hash_mismatch: 409, amount_required: 422, exceeds_refundable: 422, order_not_ready: 422 } as const;

interface AdminDeps {
  cases: CaseRepo;
  approvals?: ApprovalRepo;
  runApproved?: (approvalId: string) => Promise<{ status: string; reason: string }>; // executes an approved refund
  adminToken?: string;
  judgeToken?: string; // read-only access for reviewers
  demo?: DemoRepo; // wipes demo data; only usable when resetEnabled is true
  resetEnabled?: boolean;
}

const ResetBody = z.object({ confirm: z.literal("reset demo data") });

export function adminRoutes({ cases, approvals, runApproved, adminToken, judgeToken, demo, resetEnabled }: AdminDeps) {
  const app = new Hono<AuthEnv>();
  app.use("*", requireAdmin(adminToken, judgeToken));

  // Lets the console know who is signed in, so it can hide the buttons a judge cannot use.
  app.get("/whoami", (c) => c.json({ role: c.get("role"), resetEnabled: Boolean(resetEnabled && demo) }));

  // Clears demo data (cases, approvals, refunds, orders, webhook events) but keeps every policy version.
  // Off unless ALLOW_DEMO_RESET=true, admin only (the guard already refuses a judge's POST), and needs a typed phrase.
  app.post("/reset", async (c) => {
    if (!resetEnabled || !demo) return c.json({ error: "reset_disabled" }, 403);
    const body = ResetBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", detail: 'send {"confirm": "reset demo data"}' }, 400);
    const r = await demo.reset();
    return r.ok ? c.json({ reset: true, deleted: r.deleted }) : c.json({ error: r.error, detail: "a refund is still in flight; wait for it to settle first" }, 409);
  });

  app.get("/cases", async (c) => c.json({ cases: await cases.list(c.req.query("status") || undefined) }));

  // Full timeline: agent run, tool calls, proposal, decision (rule ids + context), execution.
  app.get("/cases/:id", async (c) => {
    const t = await cases.timeline(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "not_found" }, 404);
  });

  // Escalated (NEEDS_HUMAN) cases: the merchant either declines, or proposes a refund. A proposed refund becomes a
  // normal pending approval (same hash, expiry, single-use and policy checks); the dashboard then confirms it.
  app.post("/cases/:id/resolve", async (c) => {
    const body = Resolve.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", detail: 'send {"action":"decline"} or {"action":"refund","remedy":"partial_tier_a","amountMinor":1900}' }, 400);
    const id = c.req.param("id");
    if (body.data.action === "decline") {
      const r = await cases.decline(id);
      return r === "declined" ? c.json({ declined: true }) : c.json({ error: r }, r === "not_found" ? 404 : 409);
    }
    if (!approvals) return c.json({ error: "approvals_not_configured" }, 503);
    const r = await approvals.createManual(id, { remedy: body.data.remedy, amountMinor: body.data.amountMinor });
    if (!r.ok) return c.json({ error: r.error }, RESOLVE_ERRORS[r.error]);
    return c.json({ approvalId: r.approvalId, paramsHash: r.paramsHash, amountMinor: r.amountMinor }, 201);
  });

  // Demo stand-in for shipment tracking: marks an order delivered N days ago so time-window rules can be exercised.
  app.post("/orders/:paypalOrderId/delivered", async (c) => {
    const body = Delivered.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", detail: "send {\"daysAgo\": 0..365}" }, 400);
    return (await cases.markDelivered(c.req.param("paypalOrderId"), body.data.daysAgo)) ? c.json({ ok: true }) : c.json({ error: "unknown_order" }, 404);
  });

  // ---- Approvals inbox ----
  app.get("/approvals", async (c) => (approvals ? c.json({ approvals: await approvals.list(c.req.query("status") ?? "pending") }) : c.json({ error: "approvals_not_configured" }, 503)));

  app.get("/approvals/:id", async (c) => {
    if (!approvals) return c.json({ error: "approvals_not_configured" }, 503);
    const a = await approvals.get(c.req.param("id"));
    return a ? c.json(a) : c.json({ error: "not_found" }, 404);
  });

  // The reviewer echoes the paramsHash they saw (proof they reviewed this exact version) and may set the amount.
  app.post("/approvals/:id/approve", async (c) => {
    if (!approvals || !runApproved) return c.json({ error: "approvals_not_configured" }, 503);
    const body = Approve.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", detail: 'send {"paramsHash": <hash you reviewed>, "amountMinor": optional positive integer}' }, 400);
    const id = c.req.param("id");
    const r = await approvals.approve(id, body.data);
    if (!r.ok) return c.json({ error: r.error }, APPROVE_ERRORS[r.error]);
    // The approval is recorded first, so a crash during execution is recovered by the sweeper rather than lost.
    const outcome = await runApproved(id);
    return c.json({ approved: true, amountMinor: r.amountMinor, caseStatus: outcome.status, detail: outcome.reason });
  });

  app.post("/approvals/:id/reject", async (c) => {
    if (!approvals) return c.json({ error: "approvals_not_configured" }, 503);
    const body = Reject.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", detail: 'send {"paramsHash": <hash you reviewed>}' }, 400);
    const r = await approvals.reject(c.req.param("id"), body.data.paramsHash);
    return r.ok ? c.json({ rejected: true }) : c.json({ error: r.error }, r.error === "not_found" ? 404 : 409);
  });

  return app;
}
