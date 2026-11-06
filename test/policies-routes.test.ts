import { describe, expect, it } from "vitest";
import type { PolicyRepo, PolicyRow } from "../src/db/policies.js";
import type { CompileReport } from "../src/policy/compiler.js";
import { policyHash } from "../src/policy/hash.js";
import { Policy } from "../src/policy/schema.js";
import { policyRoutes } from "../src/routes/policies.js";

const TOKEN = "correct-horse-battery-staple";
const PROSE = "We refund damaged items by half within thirty days of delivery.";

const policy = Policy.parse({
  currency: "USD",
  rules: [{ id: "R1", effect: "allow", remedy: "partial_tier_b", when: {}, amount: { percent_of_capture: 50 } }],
});
const HASH = policyHash(policy);

const report = (over: Partial<CompileReport> = {}): CompileReport => ({
  policy, rulesHash: HASH, schemaErrors: [], cases: [], mismatches: 0, warnings: [], ambiguities: [], unsupported: [], attempts: 1, activatable: true, ...over,
});

function setup(opts: { adminToken?: string | null; compile?: ((p: string) => Promise<CompileReport>) | null; activateResult?: "activated" | "not_found" | "not_draft" } = {}) {
  const rows = new Map<string, PolicyRow>();
  let n = 0;
  const activated: string[] = [];
  const repo: PolicyRepo = {
    async createDraft(d) {
      const id = `p${++n}`;
      rows.set(id, { id, version: n, status: "draft", sourceText: d.sourceText, rulesJson: d.rules, rulesHash: d.rulesHash, report: d.report, createdAt: new Date() });
      return { id, version: n };
    },
    async get(id) { return rows.get(id); },
    async getActive() { return [...rows.values()].find((r) => r.status === "active"); },
    async list() { return [...rows.values()].map(({ id, version, status, rulesHash, createdAt }) => ({ id, version, status, rulesHash, createdAt })); },
    async activate(id) {
      const result = opts.activateResult ?? "activated";
      if (result === "activated") { activated.push(id); const r = rows.get(id); if (r) r.status = "active"; }
      return result;
    },
  };
  const compile = opts.compile === null ? undefined : (opts.compile ?? (async () => report()));
  const app = policyRoutes({ repo, compile, adminToken: opts.adminToken === null ? undefined : (opts.adminToken ?? TOKEN) });
  const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, rows, activated };
}

describe("policy routes: admin guard", () => {
  it("answers 503 on every route when no ADMIN_TOKEN is configured", async () => {
    const s = setup({ adminToken: null });
    for (const [m, p] of [["POST", "/compile"], ["GET", "/"], ["GET", "/active"], ["GET", "/x"], ["POST", "/x/activate"]] as const) {
      expect((await s.call(m, p, m === "POST" ? {} : undefined)).status).toBe(503);
    }
  });

  it("rejects a missing, malformed or wrong token with 401 and stores nothing", async () => {
    let compiled = 0;
    const s = setup({ compile: async () => { compiled++; return report(); } });
    expect((await s.call("POST", "/compile", { prose: PROSE }, null)).status).toBe(401);
    expect((await s.call("POST", "/compile", { prose: PROSE }, "wrong-token-of-any-length")).status).toBe(401);
    expect((await s.call("GET", "/", undefined, "")).status).toBe(401);
    expect(compiled).toBe(0); // no model spend without a valid token
    expect(s.rows.size).toBe(0);
  });
});

describe("policy routes: compile", () => {
  it("saves a valid compile as a draft and returns the hash to review", async () => {
    const s = setup();
    const res = await s.call("POST", "/compile", { prose: PROSE });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "p1", version: 1, status: "draft", rulesHash: HASH });
    expect(s.rows.get("p1")?.sourceText).toBe(PROSE);
  });

  it("rejects too-short, too-long or missing prose before spending anything", async () => {
    let compiled = 0;
    const s = setup({ compile: async () => { compiled++; return report(); } });
    expect((await s.call("POST", "/compile", { prose: "refund stuff" })).status).toBe(400);
    expect((await s.call("POST", "/compile", { prose: "x".repeat(8001) })).status).toBe(400);
    expect((await s.call("POST", "/compile", {})).status).toBe(400);
    expect(compiled).toBe(0);
  });

  it("answers 503 when the compiler is not configured (no Anthropic key)", async () => {
    expect((await setup({ compile: null }).call("POST", "/compile", { prose: PROSE })).status).toBe(503);
  });

  it("maps a model/network failure to 502 without leaking details, and stores nothing", async () => {
    const s = setup({ compile: async () => { throw new Error("sk-ant-secret in message"); } });
    const res = await s.call("POST", "/compile", { prose: PROSE });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
    expect(s.rows.size).toBe(0);
  });

  it("returns 422 and stores nothing when the policy did not validate", async () => {
    const s = setup({ compile: async () => report({ policy: null, rulesHash: null, schemaErrors: ["rules.0.amount: required"], activatable: false }) });
    const res = await s.call("POST", "/compile", { prose: PROSE });
    expect(res.status).toBe(422);
    expect((await res.json() as { schemaErrors: string[] }).schemaErrors).toEqual(["rules.0.amount: required"]);
    expect(s.rows.size).toBe(0);
  });

  it("stores a valid-but-not-activatable policy as a draft so the merchant can see why", async () => {
    const s = setup({ compile: async () => report({ mismatches: 2, activatable: false }) });
    expect((await s.call("POST", "/compile", { prose: PROSE })).status).toBe(201);
    expect(s.rows.size).toBe(1);
  });
});

describe("policy routes: activate", () => {
  const draft = async (s: ReturnType<typeof setup>) => { await s.call("POST", "/compile", { prose: PROSE }); return "p1"; };

  it("activates a draft when the caller confirms the exact hash they reviewed", async () => {
    const s = setup();
    const id = await draft(s);
    const res = await s.call("POST", `/${id}/activate`, { confirm: true, rulesHash: HASH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "active", version: 1 });
    expect(s.activated).toEqual(["p1"]);
  });

  it("requires explicit confirmation", async () => {
    const s = setup();
    const id = await draft(s);
    expect((await s.call("POST", `/${id}/activate`, { rulesHash: HASH })).status).toBe(400);
    expect((await s.call("POST", `/${id}/activate`, { confirm: false, rulesHash: HASH })).status).toBe(400);
    expect(s.activated).toEqual([]);
  });

  it("refuses when the hash differs from what is stored (policy changed since review)", async () => {
    const s = setup();
    const id = await draft(s);
    const res = await s.call("POST", `/${id}/activate`, { confirm: true, rulesHash: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(s.activated).toEqual([]);
  });

  it("refuses a draft whose generated tests disagreed with the engine", async () => {
    const s = setup({ compile: async () => report({ mismatches: 1, activatable: false }) });
    const id = await draft(s);
    expect((await s.call("POST", `/${id}/activate`, { confirm: true, rulesHash: HASH })).status).toBe(422);
    expect(s.activated).toEqual([]);
  });

  it("404s an unknown id and 409s one that is already active", async () => {
    const s = setup();
    expect((await s.call("POST", "/nope/activate", { confirm: true, rulesHash: HASH })).status).toBe(404);
    const id = await draft(s);
    await s.call("POST", `/${id}/activate`, { confirm: true, rulesHash: HASH });
    expect((await s.call("POST", `/${id}/activate`, { confirm: true, rulesHash: HASH })).status).toBe(409);
  });

  it("returns 409 when the database says someone else got there first", async () => {
    const s = setup({ activateResult: "not_draft" });
    const id = await draft(s);
    expect((await s.call("POST", `/${id}/activate`, { confirm: true, rulesHash: HASH })).status).toBe(409);
  });
});

describe("policy routes: reads", () => {
  it("serves /active before /:id, and 404s when nothing is active", async () => {
    const s = setup();
    expect((await s.call("GET", "/active")).status).toBe(404);
    await s.call("POST", "/compile", { prose: PROSE });
    await s.call("POST", "/p1/activate", { confirm: true, rulesHash: HASH });
    const res = await s.call("GET", "/active");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "p1", status: "active" });
    expect((await s.call("GET", "/missing")).status).toBe(404);
    expect(((await (await s.call("GET", "/")).json()) as { policies: unknown[] }).policies).toHaveLength(1);
  });
});
