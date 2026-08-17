import { z } from "zod";

export const createTargetAudienceSchema = z.object({
  name: z.string().min(1).max(255),
  searchQuery: z.string().min(1).max(500),
  country: z.string().optional(),
  city: z.string().optional(),
  resultsPerRun: z.number().int().min(1).max(500).default(100),
  schedule: z.string().optional(), // cron expression
});

export const updateTargetAudienceSchema = createTargetAudienceSchema.partial();

export type CreateTargetAudienceInput = z.infer<
  typeof createTargetAudienceSchema
>;
export type UpdateTargetAudienceInput = z.infer<
  typeof updateTargetAudienceSchema
>;
