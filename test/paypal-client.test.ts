import { describe, expect, it } from "vitest";
import { PayPalError, createPayPalClient } from "../src/paypal/client.js";

const cfg = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "id", clientSecret: "secret" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakePayPal(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth2/token")) return json({ access_token: `tok${calls.filter((c) => c.url.endsWith("/token")).length}`, expires_in: 3600 });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchFn, calls, tokenCalls: () => calls.filter((c) => c.url.endsWith("/v1/oauth2/token")).length };
}

describe("PayPal client", () => {
  it("caches the access token across requests", async () => {
    const pp = fakePayPal(() => json({ id: "C1", status: "COMPLETED", amount: { currency_code: "USD", value: "38.00" } }));
    const client = createPayPalClient(cfg, pp.fetchFn);
    await client.getCapture("C1");
    await client.getCapture("C1");
    expect(pp.tokenCalls()).toBe(1);
  });

  it("refreshes the token when it is about to expire", async () => {
    let t = 0;
    const pp = fakePayPal(() => json({ id: "C1", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }));
    const client = createPayPalClient(cfg, pp.fetchFn, () => t);
    await client.getCapture("C1");
    t = 3600 * 1000 - 30_000; // inside the 60s safety margin
    await client.getCapture("C1");
    expect(pp.tokenCalls()).toBe(2);
  });

  it("refreshes once on a 401 and retries", async () => {
    let first = true;
    const pp = fakePayPal(() => {
      if (first) { first = false; return json({ name: "AUTHENTICATION_FAILURE" }, 401); }
      return json({ id: "C1", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } });
    });
    const client = createPayPalClient(cfg, pp.fetchFn);
    await expect(client.getCapture("C1")).resolves.toMatchObject({ id: "C1" });
    expect(pp.tokenCalls()).toBe(2);
  });

  it("does not retry forever on repeated 401s", async () => {
    const pp = fakePayPal(() => json({}, 401));
    await expect(createPayPalClient(cfg, pp.fetchFn).getCapture("C1")).rejects.toBeInstanceOf(PayPalError);
  });

  it("sends PayPal-Request-Id and a decimal amount on refunds", async () => {
    const pp = fakePayPal(() => json({ id: "R1", status: "COMPLETED" }, 201));
    const client = createPayPalClient(cfg, pp.fetchFn);
    const out = await client.refundCapture({ captureId: "C1", amountMinor: 1900, currency: "USD", requestId: "req-1" });
    const call = pp.calls.find((c) => c.url.endsWith("/refund"))!;
    expect((call.init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("req-1");
    expect(JSON.parse(call.init.body as string).amount).toEqual({ currency_code: "USD", value: "19.00" });
    expect(out.replayed).toBe(false);
  });

  it("flags a replayed refund (HTTP 200) so the executor can tell", async () => {
    const pp = fakePayPal(() => json({ id: "R1", status: "COMPLETED" }, 200));
    const out = await createPayPalClient(cfg, pp.fetchFn).refundCapture({
      captureId: "C1", amountMinor: 1000, currency: "USD", requestId: "req-1",
    });
    expect(out.replayed).toBe(true);
  });

  it("surfaces PayPal errors with the debug id", async () => {
    const pp = fakePayPal(() => new Response("{}", { status: 422, headers: { "paypal-debug-id": "dbg9" } }));
    await expect(createPayPalClient(cfg, pp.fetchFn).getCapture("C1")).rejects.toMatchObject({ status: 422, debugId: "dbg9" });
  });

  it("treats only SUCCESS as a verified webhook", async () => {
    for (const [status, expected] of [["SUCCESS", true], ["FAILURE", false]] as const) {
      const pp = fakePayPal(() => json({ verification_status: status }));
      const ok = await createPayPalClient(cfg, pp.fetchFn).verifyWebhook({
        authAlgo: "a", certUrl: "c", transmissionId: "t", transmissionSig: "s", transmissionTime: "x", webhookId: "w", event: {},
      });
      expect(ok).toBe(expected);
    }
  });
});
