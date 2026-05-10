import { z } from "zod";

export const triggerScrapeSchema = z.object({
  query: z.string().min(1).max(500).optional(),
});

export const listJobsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type TriggerScrapeInput = z.infer<typeof triggerScrapeSchema>;
export type ListJobsInput = z.infer<typeof listJobsSchema>;
