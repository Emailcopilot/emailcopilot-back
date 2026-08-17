import { z } from "zod";

export const createEmailAccountSchema = z.object({
  profileName: z.string().min(1).max(100),
  email: z.email(),
  sendName: z.string().min(1).max(100).optional(),
  provider: z.enum(["gmail", "outlook", "smtp"]).default("smtp"),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.number().int().min(1).max(65535).default(587).optional(),
  smtpPass: z.string().min(1).optional(),
  dailyLimit: z.number().int().min(1).max(10000).default(50),
});

export const updateEmailAccountSchema = createEmailAccountSchema
  .omit({ smtpPass: true })
  .partial()
  .extend({
    smtpPass: z.string().min(1).optional(), // optional on update
  });

export type CreateEmailAccountInput = z.infer<typeof createEmailAccountSchema>;
export type UpdateEmailAccountInput = z.infer<typeof updateEmailAccountSchema>;
