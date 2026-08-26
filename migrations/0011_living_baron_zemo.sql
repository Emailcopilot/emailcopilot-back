CREATE TYPE "public"."sent_email_status_enum" AS ENUM('pending', 'sent', 'failed', 'bounced', 'replied');--> statement-breakpoint
ALTER TYPE "public"."copilot_lead_status_enum" ADD VALUE 'bounced';--> statement-breakpoint
ALTER TYPE "public"."copilot_lead_status_enum" ADD VALUE 'replied';--> statement-breakpoint
CREATE TABLE "sent_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"copilot_id" integer,
	"copilot_lead_id" integer,
	"lead_id" integer,
	"email_account_id" integer,
	"template_id" integer,
	"sequence_step" integer DEFAULT 0 NOT NULL,
	"to_email" varchar(255) NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"message_id" varchar(998),
	"in_reply_to" varchar(998),
	"status" "sent_email_status_enum" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp,
	"failed_at" timestamp,
	"bounced_at" timestamp,
	"replied_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copilot_leads" ADD COLUMN "current_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "copilot_leads" ADD COLUMN "replied_at" timestamp;--> statement-breakpoint
ALTER TABLE "copilot_leads" ADD COLUMN "bounced_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "imap_host" varchar(255);--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "imap_port" integer DEFAULT 993;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "imap_pass" text;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "imap_last_uid" integer;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "imap_last_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "oauth_access_token" text;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "oauth_refresh_token" text;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "oauth_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "oauth_scopes" text;--> statement-breakpoint
ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_copilot_id_copilots_id_fk" FOREIGN KEY ("copilot_id") REFERENCES "public"."copilots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_copilot_lead_id_copilot_leads_id_fk" FOREIGN KEY ("copilot_lead_id") REFERENCES "public"."copilot_leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_email_account_id_email_account_id_fk" FOREIGN KEY ("email_account_id") REFERENCES "public"."email_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sent_emails_message_id_uidx" ON "sent_emails" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "sent_emails_copilot_lead_step_idx" ON "sent_emails" USING btree ("copilot_lead_id","sequence_step");--> statement-breakpoint
CREATE INDEX "sent_emails_account_sent_at_idx" ON "sent_emails" USING btree ("email_account_id","sent_at");--> statement-breakpoint
CREATE INDEX "sent_emails_status_sent_at_idx" ON "sent_emails" USING btree ("status","sent_at");