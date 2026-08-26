ALTER TYPE "public"."email_account_status" ADD VALUE 'disabled';--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "smtp_status" "email_account_status" DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "imap_status" "email_account_status" DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "last_smtp_error" text;--> statement-breakpoint
ALTER TABLE "email_account" ADD COLUMN "last_imap_error" text;--> statement-breakpoint
ALTER TABLE "email_account" DROP COLUMN "status";