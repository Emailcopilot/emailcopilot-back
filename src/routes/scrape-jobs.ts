import { Router } from "express";
import * as scrapeJobService from "../services/scrape-job.service";

export const scrapeJobsRouter: Router = Router();

// GET /api/scrape-jobs
scrapeJobsRouter.get("/", scrapeJobService.listScrapeJobs);

// GET /api/scrape-jobs/:id
scrapeJobsRouter.get("/:id", scrapeJobService.getScrapeJob);
