import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import { z } from "zod";
import * as emailService from "../services/email.service";

export const emailsRouter: Router = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /emails/logs
emailsRouter.get(
  "/logs",
  validate(paginationSchema, "query"),
  emailService.listEmailLogs,
);
