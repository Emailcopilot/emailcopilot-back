CREATE TYPE "public"."email_log_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'queued', 'sent', 'replied', 'disqualified');--> statement-breakpoint
CREATE TYPE "public"."scrape_job_status" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "email_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"template_id" integer,
	"subject" text NOT NULL,
	"status" "email_log_status" NOT NULL,
	"error_message" text,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_name" text NOT NULL,
	"email" text NOT NULL,
	"website" text,
	"phone" text,
	"address" text,
	"source_query" text,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"notes" text,
	"scrape_job_id" integer,
	"scraped_at" timestamp DEFAULT now() NOT NULL,
	"emailed_at" timestamp,
	"replied_at" timestamp,
	CONSTRAINT "leads_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "scrape_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"status" "scrape_job_status" DEFAULT 'running' NOT NULL,
	"leads_found" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"ran_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_unique" UNIQUE("key")
);
