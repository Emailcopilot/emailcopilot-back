CREATE TYPE "public"."copilot_test_email_status" AS ENUM('success', 'failed');--> statement-breakpoint
CREATE TABLE "copilot_test_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"copilot_id" integer NOT NULL,
	"email_account_id" integer,
	"template_id" integer,
	"status" "copilot_test_email_status" NOT NULL,
	"to_email" varchar(255) NOT NULL,
	"subject" text,
	"message_id" varchar(998),
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copilot_test_emails" ADD CONSTRAINT "copilot_test_emails_copilot_id_copilots_id_fk" FOREIGN KEY ("copilot_id") REFERENCES "public"."copilots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_test_emails" ADD CONSTRAINT "copilot_test_emails_email_account_id_email_account_id_fk" FOREIGN KEY ("email_account_id") REFERENCES "public"."email_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_test_emails" ADD CONSTRAINT "copilot_test_emails_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copilot_test_emails_copilot_created_idx" ON "copilot_test_emails" USING btree ("copilot_id","created_at");