import { z } from "zod";

const scheduleSettingsSchema = z.object({
  runAt: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
}).optional();

export const createCopilotSchema = z.object({
  name: z.string().min(1).max(150),
  description: z.string().optional(),
  emailProfileId: z.number().int().positive().optional(),
  templateId: z.number().int().positive().optional(),
  scrapeProfileId: z.number().int().positive().optional(),
  sendLimit: z.number().int().positive().optional(),
  settings: z.object({
    schedule: scheduleSettingsSchema,
  }).optional(),
});

export const updateCopilotSchema = createCopilotSchema.partial();

export const updateCopilotStatusSchema = z.object({
  status: z.enum(["draft", "active", "paused", "archived", "running", "completed"]),
});

export type CreateCopilotInput = z.infer<typeof createCopilotSchema>;
export type UpdateCopilotInput = z.infer<typeof updateCopilotSchema>;
export type UpdateCopilotStatusInput = z.infer<typeof updateCopilotStatusSchema>;
