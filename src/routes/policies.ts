// Admin-only API for the policy lifecycle: compile (spends model money) -> review -> activate.
// Nothing here is public: without ADMIN_TOKEN configured every route answers 503.

import { Hono } from "hono";
import { z } from "zod";
import type { PolicyRepo } from "../db/policies.js";
import type { CompileReport } from "../policy/compiler.js";
import { type AuthEnv, requireAdmin } from "./admin.js";

interface Deps {
  repo: PolicyRepo;
  compile?: (prose: string) => Promise<CompileReport>; // undefined when ANTHROPIC_API_KEY is not set
  adminToken?: string;
  judgeToken?: string; // read-only: may list and view policies, cannot compile or activate
}

const CompileBody = z.object({ prose: z.string().trim().min(20).max(8000) });
const ActivateBody = z.object({ rulesHash: z.string().length(64), confirm: z.literal(true) });

// What gets stored next to the rules: everything a human needs to review the draft.
const reportOf = (r: CompileReport) => ({
  cases: r.cases, mismatches: r.mismatches, warnings: r.warnings,
  ambiguities: r.ambiguities, unsupported: r.unsupported, activatable: r.activatable, attempts: r.attempts,
});

export function policyRoutes({ repo, compile, adminToken, judgeToken }: Deps) {
  const app = new Hono<AuthEnv>();

  app.use("*", requireAdmin(adminToken, judgeToken));

  app.post("/compile", async (c) => {
    if (!compile) return c.json({ error: "compiler_not_configured" }, 503);
    const body = CompileBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_prose", detail: "policy text must be 20 to 8000 characters" }, 400);

    let report: CompileReport;
    try {
      report = await compile(body.data.prose);
    } catch (e) {
      console.error("policy compile failed:", e instanceof Error ? e.message : "unknown error");
      return c.json({ error: "compile_failed" }, 502);
    }
    // An invalid policy is never stored: there is nothing reviewable to activate.
    if (!report.policy || !report.rulesHash) return c.json({ error: "compile_invalid", report: reportOf(report), schemaErrors: report.schemaErrors }, 422);

    const saved = await repo.createDraft({ sourceText: body.data.prose, rules: report.policy, rulesHash: report.rulesHash, report: reportOf(report) });
    return c.json({ id: saved.id, version: saved.version, status: "draft", rulesHash: report.rulesHash, policy: report.policy, report: reportOf(report) }, 201);
  });

  app.get("/", async (c) => c.json({ policies: await repo.list() }));

  app.get("/active", async (c) => {
    const row = await repo.getActive();
    return row ? c.json(row) : c.json({ error: "no_active_policy" }, 404);
  });

  app.get("/:id", async (c) => {
    const row = await repo.get(c.req.param("id"));
    return row ? c.json(row) : c.json({ error: "not_found" }, 404);
  });

  app.post("/:id/activate", async (c) => {
    const body = ActivateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "confirmation_required", detail: "send {\"confirm\": true, \"rulesHash\": <the hash you reviewed>}" }, 400);

    const row = await repo.get(c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.status !== "draft") return c.json({ error: "not_a_draft" }, 409);
    if (row.rulesHash !== body.data.rulesHash) return c.json({ error: "hash_mismatch", detail: "the policy changed since you reviewed it" }, 409);
    if ((row.report as { activatable?: boolean } | null)?.activatable !== true) return c.json({ error: "not_activatable", detail: "generated tests disagree with the engine, or none were generated" }, 422);

    const result = await repo.activate(row.id);
    if (result !== "activated") return c.json({ error: result }, 409);
    return c.json({ id: row.id, version: row.version, status: "active" });
  });

  return app;
}
