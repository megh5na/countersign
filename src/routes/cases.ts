// Public support form. Anyone can open a case, so everything here is built to be cheap to refuse:
// strict input limits, one live case per order (database-enforced), and a cap on concurrent model runs.

import { Hono } from "hono";
import { z } from "zod";
import type { CaseRepo } from "../db/cases.js";

const Body = z.object({ orderId: z.string().trim().min(1).max(64), message: z.string().trim().min(10).max(2000) });

export function createLimiter(max: number) {
  let inFlight = 0;
  return {
    tryAcquire() { if (inFlight >= max) return false; inFlight++; return true; },
    release() { inFlight = Math.max(0, inFlight - 1); },
  };
}

interface Deps {
  cases: CaseRepo;
  run?: (caseId: string) => Promise<unknown>; // runs the pipeline; the route does not wait for it. Absent = agent not configured
  limiter?: ReturnType<typeof createLimiter>;
}

export function caseRoutes({ cases, run, limiter = createLimiter(3) }: Deps) {
  const app = new Hono();

  app.post("/", async (c) => {
    if (!run) return c.json({ error: "agent_not_configured" }, 503);
    const body = Body.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request", detail: "orderId is required; message must be 10 to 2000 characters" }, 400);
    if (!limiter.tryAcquire()) return c.json({ error: "busy", detail: "too many cases are being processed; try again shortly" }, 429);

    let result;
    try {
      result = await cases.open(body.data.orderId, body.data.message);
    } catch (e) {
      limiter.release();
      throw e;
    }
    if (!result.ok) {
      limiter.release();
      const status = result.error === "duplicate_active" ? 409 : result.error === "unknown_order" ? 404 : 422;
      return c.json({ error: result.error }, status);
    }

    const caseId = result.caseId;
    void run(caseId)
      .catch((e) => console.error("case run crashed:", caseId, e instanceof Error ? e.message : "unknown error"))
      .finally(() => limiter.release());
    return c.json({ caseId, status: "open" }, 202);
  });

  // The buyer-facing view shows only the status: rule ids, amounts and reasons stay with the merchant.
  app.get("/:id", async (c) => {
    const s = await cases.status(c.req.param("id"));
    return s ? c.json({ status: s.status }) : c.json({ error: "not_found" }, 404);
  });

  return app;
}
