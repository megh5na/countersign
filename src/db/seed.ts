// Seeding: make a fresh database usable. Installs the demo policy as the active policy, but only when no policy is active,
// so running it twice (or on a database that already has a policy) changes nothing.

import { DEMO_POLICY, DEMO_POLICY_TEXT } from "../policy/demoPolicy.js";
import { policyHash } from "../policy/hash.js";
import type { Db } from "./client.js";
import { createPolicyRepo } from "./policies.js";

export type SeedResult = { seeded: true; version: number } | { seeded: false; reason: "a policy is already active"; version: number };

export async function seedDemoPolicy(db: Db): Promise<SeedResult> {
  const repo = createPolicyRepo(db);
  const active = await repo.getActive();
  if (active) return { seeded: false, reason: "a policy is already active", version: active.version };
  const draft = await repo.createDraft({
    sourceText: DEMO_POLICY_TEXT,
    rules: DEMO_POLICY,
    rulesHash: policyHash(DEMO_POLICY),
    report: { activatable: true, cases: [], mismatches: 0, warnings: [], ambiguities: [], unsupported: [], seeded: true },
  });
  const result = await repo.activate(draft.id);
  if (result !== "activated") throw new Error(`could not activate the seeded policy: ${result}`);
  return { seeded: true, version: draft.version };
}
