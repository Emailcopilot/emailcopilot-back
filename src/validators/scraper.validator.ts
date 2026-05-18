import { z } from "zod";

export const listJobsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListJobsInput = z.infer<typeof listJobsSchema>;