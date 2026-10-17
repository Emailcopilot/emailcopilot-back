import { z } from "zod";

export const listLeadsSchema = z.object({
  copilotId: z.coerce.number().int().positive().optional(),
  companyName: z.string().trim().max(200).optional(),
  email: z.string().trim().max(320).optional(),
  website: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(50).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const updateLeadSuppressionSchema = z.object({
  doNotContact: z.boolean(),
});

export type ListLeadsInput = z.infer<typeof listLeadsSchema>;
export type UpdateLeadSuppressionInput = z.infer<typeof updateLeadSuppressionSchema>;
