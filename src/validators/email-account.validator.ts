import { z } from "zod";

const smtpFields = {
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpPass: z.string().min(1).optional(),
  imapHost: z.string().min(1).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapPass: z.string().min(1).optional(),
};

export const createEmailAccountSchema = z
  .object({
    profileName: z.string().min(1).max(100),
    email: z.email(),
    sendName: z.string().min(1).max(100).optional(),
    provider: z.enum(["gmail", "outlook", "smtp"]).default("smtp"),
    ...smtpFields,
    /** @deprecated Not stored; daily limits live on flight_schedule */
    dailyLimit: z.number().int().min(1).max(10000).optional(),
  })
  .superRefine((data, ctx) => {
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

export const updateEmailAccountSchema = z.object({
  profileName: z.string().min(1).max(100).optional(),
  email: z.email().optional(),
  sendName: z.string().min(1).max(100).optional(),
  provider: z.enum(["gmail", "outlook", "smtp"]).optional(),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpPass: z.string().min(1).optional(),
  imapHost: z.string().min(1).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapPass: z.string().min(1).optional(),
  dailyLimit: z.number().int().min(1).max(10000).optional(),
});

export type CreateEmailAccountInput = z.infer<typeof createEmailAccountSchema>;
export type UpdateEmailAccountInput = z.infer<typeof updateEmailAccountSchema>;
