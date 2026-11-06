// Canonical JSON + SHA-256, so the same policy always hashes the same regardless of key order.
// Used for policies.rules_hash now, and for binding approvals to an exact policy version later (I6).

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const policyHash = (policy: unknown) => sha256Hex(canonicalJson(policy));
