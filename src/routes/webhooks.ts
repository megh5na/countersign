// to post events, provide an update path.

import { Hono } from "hono";
import { WebhookEvent, type WebhookRepo } from "../db/repos.js";
import type { PayPalClient } from "../paypal/client.js";

interface Deps {
  paypal: Pick<PayPalClient, "verifyWebhook">;
  repo: WebhookRepo;
  webhookId?: string;
}

export function webhookRoutes({ paypal, repo, webhookId }: Deps) {
  const app = new Hono();

  app.post("/", async (c) => {
    if (!webhookId) return c.json({ error: "webhook_not_configured" }, 503);

    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "bad_json" }, 400);
    }
    const event = WebhookEvent.safeParse(raw);
    if (!event.success) return c.json({ error: "bad_event" }, 400);

    const h = (name: string) => c.req.header(name);
    const authAlgo = h("paypal-auth-algo");
    const certUrl = h("paypal-cert-url");
    const transmissionId = h("paypal-transmission-id");
    const transmissionSig = h("paypal-transmission-sig");
    const transmissionTime = h("paypal-transmission-time");
    if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
      return c.json({ error: "missing_signature_headers" }, 400);
    }

    // I9: nothing is stored or acted on until PayPal itself says the signature is valid.
    let verified: boolean;
    try {
      verified = await paypal.verifyWebhook({
        authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime, webhookId, event: raw,
      });
    } catch {
      return c.json({ error: "verification_unavailable" }, 503); // 5xx makes PayPal redeliver
    }
    if (!verified) return c.json({ error: "invalid_signature" }, 400);

    const status = await repo.recordEvent({ paypalEventId: event.data.id, type: event.data.event_type, payload: raw });
    if (status === "duplicate") return c.json({ ok: true, duplicate: true });

    await repo.applyEvent(event.data); // a throw here yields 500, PayPal redelivers, status becomes "retry"
    await repo.markProcessed(event.data.id);
    return c.json({ ok: true });
  });

  return app;
}
