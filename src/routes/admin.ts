// Admin guard shared by every non-public route, plus the admin-only case endpoints.
// Without ADMIN_TOKEN configured, all of it answers 503: nothing is ever open by accident.

import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ApprovalRepo } from "../db/approvals.js";
import type { CaseRepo } from "../db/cases.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function requireAdmin(adminToken?: string): MiddlewareHandler {
  return async (c, next) => {
    if (!adminToken) return c.json({ error: "admin_not_configured" }, 503);
    const h = c.req.header("authorization");
    const given = h?.startsWith("Bearer ") ? h.slice(7) : "";
    if (!timingSafeEqual(digest(given), digest(adminToken))) return c.json({ error: "unauthorized" }, 401); // fixed-length digests: constant time
    await next();
  };
}

const Delivered = z.object({ daysAgo: z.number().int().min(0).max(365) });
const Approve = z.object({ paramsHash: z.string().length(64), amountMinor: z.number().int().positive().max(10_000_000).optional() });
const Reject = z.object({ paramsHash: z.string().length(64) });

const APPROVE_ERRORS = { not_found: 404, not_pending: 409, expired: 410, hash_mismatch: 409, amount_required: 422, exceeds_refundable: 422, order_not_ready: 422 } as const;

interface AdminDeps {
  cases: CaseRepo;
  approvals?: ApprovalRepo;
  runApproved?: (approvalId: string) => Promise<{ status: string; reason: string }>; // executes an approved refund
  adminToken?: string;
}

export function adminRoutes({ cases, approvals, runApproved, adminToken }: AdminDeps) {
  const app = new Hono();
  app.use("*", requireAdmin(adminToken));

  // Full timeline: agent run, tool calls, proposal, decision (rule ids + context), execution.
  app.get("/cases/:id", async (c) => {
    const t = await cases.timeline(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "not_found" }, 404);
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
