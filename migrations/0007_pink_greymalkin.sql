ALTER TYPE "public"."email_profile_status" RENAME TO "email_account_status";--> statement-breakpoint
ALTER TABLE "email_profiles" RENAME TO "email_account";--> statement-breakpoint
ALTER TABLE "scrape_profiles" RENAME TO "target_audience";--> statement-breakpoint
ALTER TABLE "copilots" RENAME COLUMN "email_profile_id" TO "email_account_id";--> statement-breakpoint
ALTER TABLE "copilots" RENAME COLUMN "scrape_profile_id" TO "target_audience_id";--> statement-breakpoint
ALTER TABLE "scrape_jobs" RENAME COLUMN "scrape_profile_id" TO "target_audience_id";--> statement-breakpoint
ALTER TABLE "usage" RENAME COLUMN "email_profiles_created" TO "email_accounts_created";--> statement-breakpoint
ALTER TABLE "copilots" DROP CONSTRAINT "copilots_email_profile_id_email_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "copilots" DROP CONSTRAINT "copilots_scrape_profile_id_scrape_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "email_account" DROP CONSTRAINT "email_profiles_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "scrape_jobs" DROP CONSTRAINT "scrape_jobs_scrape_profile_id_scrape_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "target_audience" DROP CONSTRAINT "scrape_profiles_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "copilots" ADD CONSTRAINT "copilots_email_account_id_email_account_id_fk" FOREIGN KEY ("email_account_id") REFERENCES "public"."email_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilots" ADD CONSTRAINT "copilots_target_audience_id_target_audience_id_fk" FOREIGN KEY ("target_audience_id") REFERENCES "public"."target_audience"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_account" ADD CONSTRAINT "email_account_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_jobs" ADD CONSTRAINT "scrape_jobs_target_audience_id_target_audience_id_fk" FOREIGN KEY ("target_audience_id") REFERENCES "public"."target_audience"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_audience" ADD CONSTRAINT "target_audience_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;