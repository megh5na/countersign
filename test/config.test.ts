import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "id",
  PAYPAL_CLIENT_SECRET: "secret",
  DATABASE_URL: "postgres://x",
};

describe("config (invariant I10: sandbox only)", () => {
  it("accepts a sandbox config", () => {
    expect(loadConfig(base).PORT).toBe(3000);
  });
  it("rejects the live PayPal host", () => {
    expect(() => loadConfig({ ...base, PAYPAL_BASE_URL: "https://api-m.paypal.com" })).toThrow();
  });
  it("rejects a lookalike host", () => {
    expect(() => loadConfig({ ...base, PAYPAL_BASE_URL: "https://sandbox.paypal.com.evil.com" })).toThrow();
  });
  it("rejects PAYPAL_ENV=live", () => {
    expect(() => loadConfig({ ...base, PAYPAL_ENV: "live" })).toThrow();
  });
});
