import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clientIp, createRateLimiter, limit } from "../src/http/rateLimit.js";

function app(opts: { max: number; windowMs: number; trustProxy?: boolean; now?: () => number }) {
  const a = new Hono();
  const limiter = createRateLimiter({ windowMs: opts.windowMs, max: opts.max }, opts.now);
  a.use("/x", limit(limiter, (c) => clientIp(c, opts.trustProxy ?? false)));
  a.all("/x", (c) => c.json({ ok: true }));
  const post = (ip?: string) => a.request("/x", { method: "POST", headers: ip ? { "x-forwarded-for": ip } : {} });
  return { a, post };
}

describe("rate limiter", () => {
  it("allows up to the limit, then answers 429 with Retry-After", async () => {
    let t = 1_000_000;
    const { post } = app({ max: 3, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 3; i++) expect((await post()).status).toBe(200);
    const blocked = await post();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(await blocked.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 60 });
    t += 30_000;
    expect((await post()).headers.get("retry-after")).toBe("30"); // counts down as the oldest hit ages out
  });

  it("is a sliding window: capacity returns as old hits expire", async () => {
    let t = 0;
    const { post } = app({ max: 2, windowMs: 1000, now: () => t });
    expect((await post()).status).toBe(200); // t=0
    t = 600;
    expect((await post()).status).toBe(200); // t=600
    expect((await post()).status).toBe(429);
    t = 1001; // the t=0 hit has expired, the t=600 one has not
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  });

  it("only limits the chosen methods: reads stay free", async () => {
    const { a } = app({ max: 1, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) expect((await a.request("/x")).status).toBe(200);
  });

  it("keeps separate buckets per key", async () => {
    const { post } = app({ max: 1, windowMs: 60_000, trustProxy: true });
    expect((await post("1.1.1.1")).status).toBe(200);
    expect((await post("1.1.1.1")).status).toBe(429);
    expect((await post("2.2.2.2")).status).toBe(200);
  });

  it("behind a trusted proxy, a forged left-hand X-Forwarded-For entry does not evade the limit", async () => {
    const { post } = app({ max: 1, windowMs: 60_000, trustProxy: true });
    // The proxy appends the real peer (9.9.9.9) on the right; the attacker controls only what is to its left.
    expect((await post("spoof-1, 9.9.9.9")).status).toBe(200);
    expect((await post("spoof-2, 9.9.9.9")).status).toBe(429);
    expect((await post("anything-else, 9.9.9.9")).status).toBe(429);
  });

  it("when the proxy is NOT trusted, X-Forwarded-For is ignored entirely", async () => {
    const { post } = app({ max: 1, windowMs: 60_000, trustProxy: false });
    expect((await post("1.1.1.1")).status).toBe(200);
    expect((await post("2.2.2.2")).status).toBe(429); // a different claimed address does not get a fresh bucket
  });

  it("a global bucket limits total volume regardless of who sends", async () => {
    const a = new Hono();
    a.use("/g", limit(createRateLimiter({ windowMs: 60_000, max: 2 }), () => "all"));
    a.post("/g", (c) => c.json({ ok: true }));
    const call = (ip: string) => a.request("/g", { method: "POST", headers: { "x-forwarded-for": ip } });
    expect((await call("1.1.1.1")).status).toBe(200);
    expect((await call("2.2.2.2")).status).toBe(200);
    expect((await call("3.3.3.3")).status).toBe(429);
  });
});
