CREATE TABLE "suppressed_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suppressed_emails" ADD CONSTRAINT "suppressed_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppressed_emails_user_email_uidx" ON "suppressed_emails" USING btree ("user_id","email");