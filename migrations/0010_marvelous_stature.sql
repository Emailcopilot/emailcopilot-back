CREATE TABLE "flight_schedule" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(150) DEFAULT 'Default' NOT NULL,
	"send_limit" integer,
	"send_limit_active" boolean DEFAULT false NOT NULL,
	"active_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL,
	"sending_hours" jsonb DEFAULT '{"start":"09:00","end":"17:00"}'::jsonb NOT NULL,
	"sending_hours_active" boolean DEFAULT false NOT NULL,
	"timezone" varchar(100) DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copilots" ADD COLUMN "flight_schedule_id" integer;--> statement-breakpoint
ALTER TABLE "flight_schedule" ADD CONSTRAINT "flight_schedule_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilots" ADD CONSTRAINT "copilots_flight_schedule_id_flight_schedule_id_fk" FOREIGN KEY ("flight_schedule_id") REFERENCES "public"."flight_schedule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilots" DROP COLUMN "send_limit";--> statement-breakpoint
ALTER TABLE "copilots" DROP COLUMN "send_limit_active";--> statement-breakpoint
ALTER TABLE "copilots" DROP COLUMN "active_days";--> statement-breakpoint
ALTER TABLE "copilots" DROP COLUMN "sending_hours";--> statement-breakpoint
ALTER TABLE "copilots" DROP COLUMN "sending_hours_active";--> statement-breakpoint
ALTER TABLE "copilots" DROP COLUMN "timezone";