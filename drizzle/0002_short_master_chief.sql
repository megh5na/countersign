ALTER TABLE "refund_ledger" ALTER COLUMN "paypal_refund_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_ledger" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_ledger" ADD COLUMN "execution_id" text;--> statement-breakpoint
CREATE INDEX "refund_ledger_capture_idx" ON "refund_ledger" USING btree ("capture_id");--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_status_ck" CHECK ("executions"."status" in ('PENDING','SUCCEEDED','FAILED','UNKNOWN'));--> statement-breakpoint
ALTER TABLE "refund_ledger" ADD CONSTRAINT "refund_ledger_status_ck" CHECK ("refund_ledger"."status" in ('reserved','completed','failed'));--> statement-breakpoint
ALTER TABLE "refund_ledger" ADD CONSTRAINT "refund_ledger_amount_ck" CHECK ("refund_ledger"."amount_minor" > 0);--> statement-breakpoint
ALTER TABLE "refund_ledger" ADD CONSTRAINT "refund_ledger_completed_has_id_ck" CHECK ("refund_ledger"."status" <> 'completed' or "refund_ledger"."paypal_refund_id" is not null);