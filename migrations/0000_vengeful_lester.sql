CREATE TYPE "public"."copilot_lead_status_enum" AS ENUM('new', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."copilot_status" AS ENUM('draft', 'active', 'paused', 'archived', 'running', 'completed');--> statement-breakpoint
CREATE TYPE "public"."email_log_status" AS ENUM('sent', 'failed', 'opened', 'replied');--> statement-breakpoint
CREATE TYPE "public"."email_profile_status" AS ENUM('active', 'inactive', 'error');--> statement-breakpoint
CREATE TYPE "public"."email_provider" AS ENUM('gmail', 'outlook', 'smtp');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('paid', 'pending', 'failed');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'queued', 'sent', 'failed', 'replied', 'disqualified', 'unsubscribed', 'pending_email');--> statement-breakpoint
CREATE TYPE "public"."lead_status_enum" AS ENUM('success', 'fail');--> statement-breakpoint
CREATE TYPE "public"."scrape_job_status" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."scrape_status" AS ENUM('idle', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'canceled', 'past_due', 'trialing', 'pending', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."template_category" AS ENUM('Cold Outreach', 'Follow-up', 'Re-engagement', 'Partnership', 'Other');--> statement-breakpoint
CREATE TYPE "public"."theme" AS ENUM('light', 'dark', 'system');--> statement-breakpoint
CREATE TABLE "copilot_leads" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "copilot_leads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"copilot_id" integer,
	"lead_id" integer,
	"status" "copilot_lead_status_enum" DEFAULT 'new' NOT NULL,
	"sent_at" timestamp,
	"failed_at" timestamp,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "copilots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"send_limit" integer DEFAULT 100 NOT NULL,
	"status" "copilot_status" DEFAULT 'draft' NOT NULL,
	"email_profile_id" integer,
	"scrape_profile_id" integer,
	"template_id" integer,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emails_sent" integer DEFAULT 0 NOT NULL,
	"emails_opened" integer DEFAULT 0 NOT NULL,
	"emails_replied" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp,
	"last_job_id" integer,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"lead_id" integer NOT NULL,
	"template_id" integer,
	"subject" text NOT NULL,
	"status" "email_log_status" NOT NULL,
	"error_message" text,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"profile_name" varchar(100) NOT NULL,
	"email" varchar(255) NOT NULL,
	"send_name" varchar(100),
	"provider" "email_provider" DEFAULT 'smtp' NOT NULL,
	"smtp_host" varchar(255),
	"smtp_port" integer DEFAULT 587,
	"smtp_pass" text,
	"status" "email_profile_status" DEFAULT 'inactive' NOT NULL,
	"sent_today" integer DEFAULT 0 NOT NULL,
	"last_verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(150) NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"category" "template_category" DEFAULT 'Other' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"subscription_id" integer,
	"mollie_payment_id" varchar(255),
	"amount" integer NOT NULL,
	"currency" varchar(10) DEFAULT 'eur' NOT NULL,
	"status" "invoice_status" DEFAULT 'pending' NOT NULL,
	"download_url" text,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"company_name" varchar(255) NOT NULL,
	"email" varchar(255),
	"website" text,
	"phone" varchar(50),
	"address" text,
	"source_query" text,
	"scrape_profile_id" integer,
	"scrape_job_id" integer,
	"scraped_at" timestamp DEFAULT now() NOT NULL,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"notes" text,
	"emailed_at" timestamp,
	"replied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "leads_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "leads2" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "leads2_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"status" "lead_status_enum" NOT NULL,
	"company_name" varchar NOT NULL,
	"email" varchar,
	"website" varchar,
	"phone" varchar,
	"address" varchar,
	"source_query" varchar,
	"place_id" varchar,
	CONSTRAINT "leads2_placeId_unique" UNIQUE("place_id")
);
--> statement-breakpoint
CREATE TABLE "scrape_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"scrape_profile_id" integer,
	"query" text NOT NULL,
	"status" "scrape_job_status" DEFAULT 'running' NOT NULL,
	"leads_found" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scrape_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"search_query" varchar(500) NOT NULL,
	"status" "scrape_status" DEFAULT 'idle' NOT NULL,
	"results_count" integer DEFAULT 0 NOT NULL,
	"last_run" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scrape_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"scrape_profile_id" integer NOT NULL,
	"data" jsonb NOT NULL,
	"scraped_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"plan_id" varchar(50) NOT NULL,
	"status" "subscription_status" DEFAULT 'pending' NOT NULL,
	"mollie_customer_id" varchar(255),
	"mollie_subscription_id" varchar(255),
	"mollie_mandate_id" varchar(255),
	"current_period_start" timestamp,
	"current_period_end" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"subscription_id" integer,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"emails_sent" integer DEFAULT 0 NOT NULL,
	"copilots_created" integer DEFAULT 0 NOT NULL,
	"email_profiles_created" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_id" varchar(255) NOT NULL,
	"first_name" varchar(100) DEFAULT '',
	"last_name" varchar(100) DEFAULT '',
	"email" varchar(255) NOT NULL,
	"timezone" varchar(100) DEFAULT 'UTC' NOT NULL,
	"theme" "theme" DEFAULT 'light' NOT NULL,
	"notify_on_reply" boolean DEFAULT true NOT NULL,
	"notify_on_bounce" boolean DEFAULT true NOT NULL,
	"notify_weekly_report" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_id_unique" UNIQUE("clerk_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "copilot_leads" ADD CONSTRAINT "copilot_leads_copilot_id_copilots_id_fk" FOREIGN KEY ("copilot_id") REFERENCES "public"."copilots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_leads" ADD CONSTRAINT "copilot_leads_lead_id_leads2_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads2"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilots" ADD CONSTRAINT "copilots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilots" ADD CONSTRAINT "copilots_email_profile_id_email_profiles_id_fk" FOREIGN KEY ("email_profile_id") REFERENCES "public"."email_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilots" ADD CONSTRAINT "copilots_scrape_profile_id_scrape_profiles_id_fk" FOREIGN KEY ("scrape_profile_id") REFERENCES "public"."scrape_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilots" ADD CONSTRAINT "copilots_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilots" ADD CONSTRAINT "copilots_last_job_id_scrape_jobs_id_fk" FOREIGN KEY ("last_job_id") REFERENCES "public"."scrape_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_profiles" ADD CONSTRAINT "email_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_scrape_profile_id_scrape_profiles_id_fk" FOREIGN KEY ("scrape_profile_id") REFERENCES "public"."scrape_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_scrape_job_id_scrape_jobs_id_fk" FOREIGN KEY ("scrape_job_id") REFERENCES "public"."scrape_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_jobs" ADD CONSTRAINT "scrape_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_jobs" ADD CONSTRAINT "scrape_jobs_scrape_profile_id_scrape_profiles_id_fk" FOREIGN KEY ("scrape_profile_id") REFERENCES "public"."scrape_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_profiles" ADD CONSTRAINT "scrape_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_results" ADD CONSTRAINT "scrape_results_scrape_profile_id_scrape_profiles_id_fk" FOREIGN KEY ("scrape_profile_id") REFERENCES "public"."scrape_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;