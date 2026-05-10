import { z } from "zod";

export const patchLeadSchema = z.object({
  status: z.enum(["new", "queued", "sent", "replied", "disqualified"]).optional(),
  notes: z.string().max(5000).optional(),
});

export const listLeadsSchema = z.object({
  status: z.enum(["new", "queued", "sent", "replied", "disqualified"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PatchLeadInput = z.infer<typeof patchLeadSchema>;
export type ListLeadsInput = z.infer<typeof listLeadsSchema>;
