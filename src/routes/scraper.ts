import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import { listJobsSchema } from "../validators/scraper.validator";
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

// GET /scraper/jobs/:id
scraperRouter.get("/jobs/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await scraperService.getScrapeJob(parseInt(req.params.id)));
  } catch (err) { next(err); }
});
