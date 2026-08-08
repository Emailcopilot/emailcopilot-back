import { emailTemplatesTable, leadsTable, scrapeJobsTable } from "./schema";

export type Lead = typeof leadsTable.$inferSelect;
export type NewLead = typeof leadsTable.$inferInsert;
export type EmailTemplate = typeof emailTemplatesTable.$inferSelect;
export type ScrapeJob = typeof scrapeJobsTable.$inferSelect;
