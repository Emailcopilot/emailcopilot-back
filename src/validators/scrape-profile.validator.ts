import { z } from "zod";

export const createScrapeProfileSchema = z.object({
  name: z.string().min(1).max(255),
  searchQuery: z.string().min(1).max(500),
  resultsPerRun: z.number().int().min(1).max(500).default(100),
  schedule: z.string().optional(), // cron expression
});

export const updateScrapeProfileSchema = createScrapeProfileSchema.partial();

export type CreateScrapeProfileInput = z.infer<typeof createScrapeProfileSchema>;
export type UpdateScrapeProfileInput = z.infer<typeof updateScrapeProfileSchema>;
