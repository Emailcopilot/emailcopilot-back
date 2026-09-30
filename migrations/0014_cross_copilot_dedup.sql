-- Cross-copilot dedup: one permanent outreach per recipient per user.
-- Once any copilot of a user has delivered (sent/bounced/replied) to an
-- address, every other copilot of that user skips it as status 'skipped'.
--
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block on
-- PostgreSQL < 12 — apply this file directly (psql -f), not via a transaction.

ALTER TYPE "public"."copilot_lead_status_enum" ADD VALUE IF NOT EXISTS 'skipped';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copilot_leads_copilot_status_idx" ON "copilot_leads" USING btree ("copilot_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sent_emails_copilot_id_idx" ON "sent_emails" USING btree ("copilot_id");
