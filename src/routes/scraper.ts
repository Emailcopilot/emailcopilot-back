import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import { triggerScrapeSchema, listJobsSchema } from "../validators/scraper.validator";
import * as scraperService from "../services/scraper.service";

export const scraperRouter: Router = Router();

// GET /scraper/jobs
scraperRouter.get(
  "/jobs",
  validate(listJobsSchema, "query"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await scraperService.listScrapeJobs(req.query as any));
    } catch (err) { next(err); }
  }
);

// POST /scraper/trigger
scraperRouter.post(
  "/trigger",
  validate(triggerScrapeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await scraperService.triggerScrapeJob(req.dbUser.id, req.body);
      res.status(202).json(result);
    } catch (err) { next(err); }
  }
);

// GET /scraper/jobs/:id
scraperRouter.get("/jobs/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await scraperService.getScrapeJob(parseInt(req.params.id)));
  } catch (err) { next(err); }
});
