ALTER TABLE "copilots" ADD COLUMN "active_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "copilots" ADD COLUMN "sending_hours" jsonb DEFAULT '{"start":"09:00","end":"17:00"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "copilots" ADD COLUMN "sending_hours_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "copilots" ADD COLUMN "timezone" varchar(100) DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "copilots" DROP COLUMN "settings";