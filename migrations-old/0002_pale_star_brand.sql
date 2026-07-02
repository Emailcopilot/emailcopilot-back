ALTER TYPE "public"."copilot_status" ADD VALUE 'running';--> statement-breakpoint
ALTER TABLE "copilots" ADD COLUMN "last_run_at" timestamp;--> statement-breakpoint
ALTER TABLE "copilots" ADD COLUMN "last_job_id" integer;--> statement-breakpoint
ALTER TABLE "copilots" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "copilots" ADD CONSTRAINT "copilots_last_job_id_scrape_jobs_id_fk" FOREIGN KEY ("last_job_id") REFERENCES "public"."scrape_jobs"("id") ON DELETE set null ON UPDATE no action;