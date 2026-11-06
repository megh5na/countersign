// Policy storage. Versioned; a policy's rules are never updated after insert (only its status changes).
// The partial unique index `policies_one_active_uq` guarantees at most one active policy.

import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { policies } from "./schema.js";

export interface PolicyRow {
  id: string;
  version: number;
  status: string;
  sourceText: string;
  rulesJson: unknown;
  rulesHash: string;
  report: unknown; // generated tests, their results, warnings, ambiguities
  createdAt: Date;
}

export interface PolicyRepo {
  createDraft(d: { sourceText: string; rules: unknown; rulesHash: string; report: unknown }): Promise<{ id: string; version: number }>;
  get(id: string): Promise<PolicyRow | undefined>;
  getActive(): Promise<PolicyRow | undefined>;
  list(): Promise<Pick<PolicyRow, "id" | "version" | "status" | "rulesHash" | "createdAt">[]>;
  activate(id: string): Promise<"activated" | "not_found" | "not_draft">;
}

const cols = {
  id: policies.id,
  version: policies.version,
  status: policies.status,
  sourceText: policies.sourceText,
  rulesJson: policies.rulesJson,
  rulesHash: policies.rulesHash,
  report: policies.testCasesJson,
  createdAt: policies.createdAt,
};

export function createPolicyRepo(db: Db): PolicyRepo {
  return {
    async createDraft(d) {
      return db.transaction(async (tx) => {
        const [m] = await tx.select({ v: sql<number>`coalesce(max(${policies.version}), 0)` }).from(policies);
        const version = Number(m?.v ?? 0) + 1;
        const id = randomUUID();
        await tx.insert(policies).values({
          id, version, sourceText: d.sourceText, rulesJson: d.rules, rulesHash: d.rulesHash, testCasesJson: d.report, status: "draft",
        });
        return { id, version };
      });
    },

    async get(id) {
      const [row] = await db.select(cols).from(policies).where(eq(policies.id, id));
      return row;
    },

    async getActive() {
      const [row] = await db.select(cols).from(policies).where(eq(policies.status, "active"));
      return row;
    },

    async list() {
      return db
        .select({ id: policies.id, version: policies.version, status: policies.status, rulesHash: policies.rulesHash, createdAt: policies.createdAt })
        .from(policies)
        .orderBy(desc(policies.version));
    },

    async activate(id) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select({ status: policies.status }).from(policies).where(eq(policies.id, id)).for("update");
        if (!row) return "not_found" as const;
        if (row.status !== "draft") return "not_draft" as const;
        await tx.update(policies).set({ status: "retired" }).where(eq(policies.status, "active"));
        await tx.update(policies).set({ status: "active" }).where(eq(policies.id, id));
        return "activated" as const;
      });
    },
  };
}
