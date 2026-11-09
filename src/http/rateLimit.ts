// In-memory sliding-window rate limiting for the PUBLIC endpoints (order creation, claims, webhooks).
// It exists mainly to bound model spend and PayPal calls. State resets on restart; that is acceptable for one instance.

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

// Behind a proxy (Render) the client address is in X-Forwarded-For. A caller can forge the LEFT side of that header,
// but the proxy appends the real peer on the RIGHT, so we use the right-most entry, and only when told to trust the proxy.
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const parts = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const last = parts.at(-1);
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // no socket info (tests): one shared bucket, which is the conservative choice
  }
}

export interface Limit {
  windowMs: number;
  max: number;
}

export function createRateLimiter(limit: Limit, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    check(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
      const t = now();
      const cutoff = t - limit.windowMs;
      const recent = (hits.get(key) ?? []).filter((x) => x > cutoff);
      if (recent.length >= limit.max) {
        hits.set(key, recent);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((recent[0] as number) + limit.windowMs - t) / 1000)) };
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.every((x) => x <= cutoff)) hits.delete(k); // bound memory under a flood of distinct keys
      }
      return { ok: true };
    },
  };
}

// Applies the limiter to the given methods only (reads stay free).
export function limit(limiter: ReturnType<typeof createRateLimiter>, key: (c: Context) => string, methods: string[] = ["POST"]): MiddlewareHandler {
  return async (c, next) => {
    if (!methods.includes(c.req.method)) return next();
    const r = limiter.check(key(c));
    if (!r.ok) {
      c.header("Retry-After", String(r.retryAfterSec));
      return c.json({ error: "rate_limited", retryAfterSeconds: r.retryAfterSec }, 429);
    }
    return next();
  };
}
