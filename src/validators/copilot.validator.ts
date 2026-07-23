import { z } from "zod";

const scheduleSettingsSchema = z
  .object({
    runAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/)
      .optional(),
  })
  .optional();

export const createCopilotSchema = z.object({
  name: z.string().min(1).max(150),
  description: z.string().optional(),
  emailProfileId: z.number().int().positive().optional(),
  emailProfile: z
    .object({
      profileName: z.string().min(1).max(150),
      email: z.email(),
      sendName: z.string().min(1).max(150),
      provider: z.enum(["smtp", "gmail"]),
      smtpHost: z.string().min(1).max(150),
      smtpPort: z.number().int().positive(),
      smtpPass: z.string().min(1).max(150),
    })
    .optional(),
  templateId: z.number().int().positive().optional(),
  scrapeProfileId: z.number().int().positive().optional(),
  scrapeProfile: z
    .object({
      name: z.string().min(1).max(150),
      searchQuery: z.string().min(1).max(500),
      country: z.string().optional(),
      city: z.string().optional(),
    })
    .optional(),
  sendLimit: z.number().int().positive().optional(),
  settings: z
    .object({
      schedule: scheduleSettingsSchema,
    })
    .optional(),
});

export const updateCopilotSchema = createCopilotSchema.partial();

export const updateCopilotStatusSchema = z.object({
  status: z.enum([
    "draft",
    "active",
    "paused",
    "archived",
    "running",
    "completed",
  ]),
});

export type CreateCopilotInput = z.infer<typeof createCopilotSchema>;
export type UpdateCopilotInput = z.infer<typeof updateCopilotSchema>;
export type UpdateCopilotStatusInput = z.infer<
  typeof updateCopilotStatusSchema
>;
