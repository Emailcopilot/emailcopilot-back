import { z } from "zod";
import { flightScheduleObject } from "./flight-schedule.validator";

const emailAccountObject = z.object({
  profileName: z.string().min(1).max(150),
  email: z.email(),
  sendName: z.string().min(1).max(150),
  provider: z.enum(["smtp", "gmail", "outlook"]),
  smtpHost: z.string().min(1).max(150).optional(),
  smtpPort: z.number().int().positive().optional(),
  smtpPass: z.string().min(1).max(150).optional(),
  imapHost: z.string().min(1).max(150).optional(),
  imapPort: z.number().int().positive().optional(),
  imapPass: z.string().min(1).max(150).optional(),
}).superRefine((data, ctx) => {
  if (data.provider === "smtp") {
    if (!data.smtpHost) {
      ctx.addIssue({
        code: "custom",
        message: "smtpHost is required for SMTP accounts",
        path: ["smtpHost"],
      });
    }
    if (!data.smtpPass) {
      ctx.addIssue({
        code: "custom",
        message: "smtpPass is required for SMTP accounts",
        path: ["smtpPass"],
      });
    }
  }
});

const targetAudienceObject = z.object({
  name: z.string().min(1).max(150),
  searchQuery: z.string().min(1).max(500),
  country: z.string().optional(),
  city: z.string().optional(),
});

export const createCopilotSchema = z.object({
  name: z.string().min(1).max(150),
  description: z.string().optional(),
  emailAccountId: z.number().int().positive().optional(),
  emailProfileId: z.number().int().positive().optional(),
  emailAccount: emailAccountObject.optional(),
  emailProfile: emailAccountObject.optional(),
  templateId: z.number().int().positive().optional(),
  template: z
    .object({
      name: z.string().min(1).max(255),
      subject: z.string().min(1).max(998),
      body: z.string().min(1),
    })
    .optional(),
  targetAudienceId: z.number().int().positive().optional(),
  scrapeProfileId: z.number().int().positive().optional(),
  targetAudience: targetAudienceObject.optional(),
  scrapeProfile: targetAudienceObject.optional(),
  flightScheduleId: z.number().int().positive().optional(),
  flightSchedule: flightScheduleObject.optional(),
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
