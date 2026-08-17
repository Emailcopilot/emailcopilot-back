import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  createScrapeProfileSchema,
  updateScrapeProfileSchema,
} from "../validators/scrape-profile.validator";
import * as scrapeProfileService from "../services/scrape-profile.service";

export const scrapeProfilesRouter: Router = Router();

scrapeProfilesRouter.get("/", scrapeProfileService.listScrapeProfiles);

scrapeProfilesRouter.get("/:id", scrapeProfileService.getScrapeProfile);

scrapeProfilesRouter.post(
  "/",
  validate(createScrapeProfileSchema),
  scrapeProfileService.createScrapeProfile,
);

scrapeProfilesRouter.put(
  "/:id",
  validate(updateScrapeProfileSchema),
  scrapeProfileService.updateScrapeProfile,
);

scrapeProfilesRouter.delete("/:id", scrapeProfileService.deleteScrapeProfile);
