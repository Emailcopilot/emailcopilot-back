import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  createScrapeProfileSchema,
  updateScrapeProfileSchema,
} from "../validators/scrape-profile.validator";
import * as scrapeProfileService from "../services/scrape-profile.service";

export const scrapeProfilesRouter: Router = Router();

// GET /api/scrape-profiles
scrapeProfilesRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await scrapeProfileService.listScrapeProfiles(req.dbUser.id));
  } catch (err) { next(err); }
});

// GET /api/scrape-profiles/:id
scrapeProfilesRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await scrapeProfileService.getScrapeProfile(Number(req.params.id), req.dbUser.id));
  } catch (err) { next(err); }
});

// POST /api/scrape-profiles
scrapeProfilesRouter.post(
  "/",
  validate(createScrapeProfileSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await scrapeProfileService.createScrapeProfile(req.dbUser.id, req.body);
      res.status(201).json(created);
    } catch (err) { next(err); }
  }
);

// PUT /api/scrape-profiles/:id
scrapeProfilesRouter.put(
  "/:id",
  validate(updateScrapeProfileSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await scrapeProfileService.updateScrapeProfile(
        Number(req.params.id),
        req.dbUser.id,
        req.body
      );
      res.json(updated);
    } catch (err) { next(err); }
  }
);

// DELETE /api/scrape-profiles/:id
scrapeProfilesRouter.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await scrapeProfileService.deleteScrapeProfile(Number(req.params.id), req.dbUser.id);
    res.status(204).send();
  } catch (err) { next(err); }
});
