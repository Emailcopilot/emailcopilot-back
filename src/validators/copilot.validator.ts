import { z } from "zod";

export const createCopilotSchema = z.object({
  name: z.string().min(1).max(150),
  description: z.string().optional(),
  emailProfileId: z.number().int().positive().optional(),
  templateId: z.number().int().positive().optional(),
  scrapeProfileId: z.number().int().positive().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const updateCopilotSchema = createCopilotSchema.partial();

export const updateCopilotStatusSchema = z.object({
  status: z.enum(["draft", "active", "paused", "archived"]),
});

export type CreateCopilotInput = z.infer<typeof createCopilotSchema>;
export type UpdateCopilotInput = z.infer<typeof updateCopilotSchema>;
export type UpdateCopilotStatusInput = z.infer<typeof updateCopilotStatusSchema>;
