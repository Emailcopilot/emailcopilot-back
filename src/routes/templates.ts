import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  createTemplateSchema,
  updateTemplateSchema,
} from "../validators/template.validator";
import * as templateService from "../services/template.service";

export const templatesRouter: Router = Router();

templatesRouter.get("/", templateService.listTemplates);
templatesRouter.get("/:id", templateService.getTemplate);
templatesRouter.post(
  "/",
  validate(createTemplateSchema),
  templateService.createTemplate,
);
templatesRouter.put(
  "/:id",
  validate(updateTemplateSchema),
  templateService.updateTemplate,
);
templatesRouter.delete("/:id", templateService.deleteTemplate);
templatesRouter.post("/:id/duplicate", templateService.duplicateTemplate);
