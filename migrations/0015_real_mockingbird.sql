DROP INDEX "suppressed_emails_user_email_uidx";--> statement-breakpoint
ALTER TABLE "suppressed_emails" ALTER COLUMN "id" SET DATA TYPE integer;--> statement-breakpoint
-- ALTER TABLE "suppressed_emails" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (sequence name "suppressed_emails_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
-- ALTER TABLE "subscriptions" ADD COLUMN "billing_interval" varchar(10) DEFAULT 'month' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "suppressed_emails_user_id_email_index" ON "suppressed_emails" USING btree ("user_id","email");