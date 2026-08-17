import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  createTargetAudienceSchema,
  updateTargetAudienceSchema,
} from "../validators/target-audience.validator";
import * as targetAudienceService from "../services/target-audience.service";

export const targetAudiencesRouter: Router = Router();
export const scrapeProfilesRouter = targetAudiencesRouter;

targetAudiencesRouter.get("/", targetAudienceService.listTargetAudiences);

targetAudiencesRouter.get("/:id", targetAudienceService.getTargetAudience);

targetAudiencesRouter.post(
  "/",
  validate(createTargetAudienceSchema),
  targetAudienceService.createTargetAudience,
);

targetAudiencesRouter.put(
  "/:id",
  validate(updateTargetAudienceSchema),
  targetAudienceService.updateTargetAudience,
);

targetAudiencesRouter.delete("/:id", targetAudienceService.deleteTargetAudience);
