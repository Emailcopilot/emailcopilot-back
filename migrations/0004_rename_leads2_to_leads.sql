ALTER TABLE "leads2" RENAME TO "leads";--> statement-breakpoint
ALTER SEQUENCE "leads2_id_seq" RENAME TO "leads_id_seq";--> statement-breakpoint
ALTER TABLE "leads" RENAME CONSTRAINT "leads2_placeId_unique" TO "leads_placeId_unique";--> statement-breakpoint
ALTER TABLE "copilot_leads" DROP CONSTRAINT "copilot_leads_lead_id_leads2_id_fk";--> statement-breakpoint
ALTER TABLE "copilot_leads" ADD CONSTRAINT "copilot_leads_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;