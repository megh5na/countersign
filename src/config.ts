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
  ADMIN_TOKEN: z.string().min(16).optional(), // guards the policy routes; they answer 503 until it is set
  JUDGE_TOKEN: z.string().min(16).optional(), // read-only access to the console (look, but cannot approve, refund, resolve or change policy)
  // The demo-reset endpoint is off unless this is exactly "true". Leave it off in any deployment that holds data you care about.
  ALLOW_DEMO_RESET: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  // Only set TRUST_PROXY=true when deployed behind a proxy you control (Render): it makes rate limits read X-Forwarded-For.
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Stops the case agent when today's model spend reaches this many US dollars (checked before each case).
  MODEL_DAILY_CAP_USD: z.coerce.number().positive().default(5),
}).refine((e) => !e.JUDGE_TOKEN || e.JUDGE_TOKEN !== e.ADMIN_TOKEN, {
  message: "JUDGE_TOKEN must differ from ADMIN_TOKEN (a judge token that equals the admin token would give judges full access)",
  path: ["JUDGE_TOKEN"],
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
