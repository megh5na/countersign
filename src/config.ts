import { z } from "zod";

// Invariant I10: sandbox only, enforced at startup. Secrets come from env vars only.
const Env = z.object({
  PAYPAL_ENV: z.literal("sandbox"),
  PAYPAL_BASE_URL: z
    .string()
    .url()
    .refine((u) => new URL(u).hostname.endsWith("sandbox.paypal.com"), {
      message: "PAYPAL_BASE_URL must be a sandbox.paypal.com host",
    }),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
