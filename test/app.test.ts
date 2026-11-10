import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// Only the routes under test are exercised; everything else is left unset on purpose.
function app(checkDb: () => Promise<void>) {
  const none = {}; // placeholder repositories: these routes never call them
  return createApp({
    checkDb, clientId: "id", env: "sandbox", paypal: none, orders: none, webhooks: none,
    cases: { repo: none }, approvals: { repo: none }, policies: { repo: none },
  } as unknown as Parameters<typeof createApp>[0]);
}

describe("keep-alive and health endpoints", () => {
  it("/ping answers without touching the database", async () => {
    let touched = 0;
    const a = app(async () => { touched++; });
    for (let i = 0; i < 3; i++) {
      const r = await a.request("/ping");
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
    expect(touched).toBe(0);
  });

  it("/ping still answers when the database is down (it is not a health check)", async () => {
    expect((await app(async () => { throw new Error("db down"); }).request("/ping")).status).toBe(200);
  });

  it("/health does check the database, and reports it honestly", async () => {
    let touched = 0;
    const ok = await app(async () => { touched++; }).request("/health");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, db: "up", env: "sandbox" });
    expect(touched).toBe(1);

    const down = await app(async () => { throw new Error("db down"); }).request("/health");
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false, db: "down" });
  });
});
