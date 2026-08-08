import { z } from "zod";

export const listLeadsSchema = z.object({
  copilotId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListLeadsInput = z.infer<typeof listLeadsSchema>;
