import { z } from "zod";
import { emailProviderEnum } from "../db/schema";

export const createEmailProfileSchema = z.object({
  profileName: z.string().min(1).max(100),
  email: z.string().email(),
  sendName: z.string().min(1).max(100).optional(),
  provider: z.enum(["gmail", "outlook", "smtp"]).default("smtp"),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.number().int().min(1).max(65535).default(587).optional(),
  smtpPass: z.string().min(1).optional(),
  dailyLimit: z.number().int().min(1).max(10000).default(50),
});

export const updateEmailProfileSchema = createEmailProfileSchema
  .omit({ smtpPass: true })
  .partial()
  .extend({
    smtpPass: z.string().min(1).optional(), // optional on update
  });

export type CreateEmailProfileInput = z.infer<typeof createEmailProfileSchema>;
export type UpdateEmailProfileInput = z.infer<typeof updateEmailProfileSchema>;
