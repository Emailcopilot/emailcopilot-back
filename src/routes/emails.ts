import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  createTemplateSchema,
  patchTemplateSchema,
} from "../validators/template.validator";
import * as templateService from "../services/template.service";
import { db } from "../db/drizzle";
import { emailLogs } from "../db/schema";
import { desc } from "drizzle-orm";
import { z } from "zod";

export const emailsRouter: Router = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /emails/logs
emailsRouter.get(
  "/logs",
  validate(paginationSchema, "query"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, limit } = req.query as any;
      const offset = (page - 1) * limit;

      const [rows, total] = await Promise.all([
        db.query.emailLogs.findMany({
          orderBy: desc(emailLogs.sentAt),
          limit,
          offset,
          with: {
            lead: { columns: { id: true, companyName: true, email: true } },
            template: { columns: { id: true, name: true } },
          },
        }),
        db.$count(emailLogs),
      ]);

      res.json({
        data: rows,
        meta: { total: Number(total), page, limit, totalPages: Math.ceil(Number(total) / limit) },
      });
    } catch (err) { next(err); }
  }
);

// GET /emails/templates
emailsRouter.get("/templates", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await templateService.listTemplates());
  } catch (err) { next(err); }
});

// POST /emails/templates
emailsRouter.post(
  "/templates",
  validate(createTemplateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await templateService.createTemplate(req.dbUser.id, req.body);
      res.status(201).json(created);
    } catch (err) { next(err); }
  }
);

// PATCH /emails/templates/:id
emailsRouter.patch(
  "/templates/:id",
  validate(patchTemplateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await templateService.patchTemplate(Number(req.params.id), req.body);
      res.json(updated);
    } catch (err) { next(err); }
  }
);

// DELETE /emails/templates/:id
emailsRouter.delete("/templates/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await templateService.deleteTemplate(Number(req.params.id));
    res.json({ success: true });
  } catch (err) { next(err); }
});
