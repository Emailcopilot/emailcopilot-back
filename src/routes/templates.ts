import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  createTemplateSchema,
  updateTemplateSchema,
} from "../validators/template.validator";
import * as templateService from "../services/template.service";

export const templatesRouter: Router = Router();

// GET /api/templates
templatesRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await templateService.listTemplates(req.dbUser.id));
  } catch (err) { next(err); }
});

// GET /api/templates/:id
templatesRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await templateService.getTemplate(req.dbUser.id, Number(req.params.id)));
  } catch (err) { next(err); }
});

// POST /api/templates
templatesRouter.post(
  "/",
  validate(createTemplateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await templateService.createTemplate(req.dbUser.id, req.body);
      res.status(201).json(created);
    } catch (err) { next(err); }
  }
);

// PUT /api/templates/:id
templatesRouter.put(
  "/:id",
  validate(updateTemplateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await templateService.updateTemplate(req.dbUser.id, Number(req.params.id), req.body);
      res.json(updated);
    } catch (err) { next(err); }
  }
);

// DELETE /api/templates/:id
templatesRouter.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await templateService.deleteTemplate(req.dbUser.id, Number(req.params.id));
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/templates/:id/duplicate
templatesRouter.post("/:id/duplicate", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const duplicate = await templateService.duplicateTemplate(req.dbUser.id, Number(req.params.id));
    res.status(201).json(duplicate);
  } catch (err) { next(err); }
});
