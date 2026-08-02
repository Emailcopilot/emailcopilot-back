ALTER TABLE "copilots" ALTER COLUMN "send_limit" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "copilots" ALTER COLUMN "send_limit" DROP NOT NULL;