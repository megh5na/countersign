import { minorToDecimal } from "../money.js";

type FetchFn = typeof fetch;

export interface PayPalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly debugId?: string,
  ) {
    super(`PayPal ${status}${debugId ? ` (${debugId})` : ""}`);
  }
}

export interface WebhookVerification {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  event: unknown;
}

const TIMEOUT_MS = 15_000;

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function createPayPalClient(cfg: PayPalConfig, fetchFn: FetchFn = fetch, now: () => number = Date.now) {
  let cached: { token: string; expiresAt: number } | null = null;

  async function getToken(force = false): Promise<string> {
    if (!force && cached && cached.expiresAt - now() > 60_000) return cached.token;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
    const res = await fetchFn(`${cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new PayPalError(res.status, await readJson(res), res.headers.get("paypal-debug-id") ?? undefined);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, expiresAt: now() + json.expires_in * 1000 };
    return cached.token;
  }

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; requestId?: string } = {},
    refreshed = false,
  ): Promise<{ status: number; data: T }> {
    const token = await getToken(refreshed);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId; // I7: retries with the same id are replays, not repeats
    const res = await fetchFn(`${cfg.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && !refreshed) return request<T>(method, path, opts, true); // expired token: refresh and retry once
    if (!res.ok) throw new PayPalError(res.status, await readJson(res), res.headers.get("paypal-debug-id") ?? undefined);
    return { status: res.status, data: (await readJson(res)) as T };
  }

  return {
    async createOrder(p: { amountMinor: number; currency: string; description: string; requestId: string }) {
      const { data } = await request<{ id: string; status: string }>("POST", "/v2/checkout/orders", {
        requestId: p.requestId,
        body: {
          intent: "CAPTURE",
          purchase_units: [
            { description: p.description, amount: { currency_code: p.currency, value: minorToDecimal(p.amountMinor) } },
          ],
        },
      });
      return data;
    },

    async captureOrder(orderId: string, requestId: string) {
      const { data } = await request<{
        id: string;
        status: string;
        payer?: { payer_id?: string; email_address?: string };
        purchase_units: { payments: { captures: { id: string; status: string }[] } }[];
      }>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { requestId, body: {} });
      return data;
    },

    async getCapture(captureId: string) {
      const { data } = await request<{ id: string; status: string; amount: { currency_code: string; value: string } }>(
        "GET",
        `/v2/payments/captures/${encodeURIComponent(captureId)}`,
      );
      return data;
    },

    // requestId is required by the type system: no refund can be sent without an idempotency key.
    async refundCapture(p: { captureId: string; amountMinor: number; currency: string; requestId: string }) {
      const { status, data } = await request<{ id: string; status: string }>(
        "POST",
        `/v2/payments/captures/${encodeURIComponent(p.captureId)}/refund`,
        {
          requestId: p.requestId,
          body: { amount: { currency_code: p.currency, value: minorToDecimal(p.amountMinor) } },
        },
      );
      return { ...data, replayed: status === 200 }; // 201 = created, 200 = PayPal replayed a stored result
    },

    async verifyWebhook(v: WebhookVerification): Promise<boolean> {
      const { data } = await request<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
        body: {
          auth_algo: v.authAlgo,
          cert_url: v.certUrl,
          transmission_id: v.transmissionId,
          transmission_sig: v.transmissionSig,
          transmission_time: v.transmissionTime,
          webhook_id: v.webhookId,
          webhook_event: v.event,
        },
      });
      return data.verification_status === "SUCCESS";
    },
  };
}

export type PayPalClient = ReturnType<typeof createPayPalClient>;
