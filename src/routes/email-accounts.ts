import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  createEmailProfileSchema,
  updateEmailProfileSchema,
} from "../validators/email-profile.validator";
import * as emailProfileService from "../services/email-profile.service";

export const emailProfilesRouter: Router = Router();

emailProfilesRouter.get("/", emailProfileService.listEmailProfiles);

emailProfilesRouter.get("/:id", emailProfileService.getEmailProfile);

emailProfilesRouter.post(
  "/",
  validate(createEmailProfileSchema),
  emailProfileService.createEmailProfile,
);

emailProfilesRouter.put(
  "/:id",
  validate(updateEmailProfileSchema),
  emailProfileService.updateEmailProfile,
);

emailProfilesRouter.delete("/:id", emailProfileService.deleteEmailProfile);

emailProfilesRouter.post("/:id/verify", emailProfileService.verifyEmailProfile);
