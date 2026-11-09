ALTER TABLE "approvals" ADD COLUMN "amount_minor" integer;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "claim_type" text;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_decision_uq" ON "approvals" USING btree ("decision_id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_status_ck" CHECK ("approvals"."status" in ('pending','approved','rejected','used','expired'));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_amount_ck" CHECK ("approvals"."amount_minor" is null or "approvals"."amount_minor" > 0);--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_has_amount_ck" CHECK ("approvals"."status" not in ('approved','used') or "approvals"."amount_minor" is not null);