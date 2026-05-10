import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db/drizzle";
import { scrapeJobs } from "../db/schema";
import { eq } from "drizzle-orm";

export const scrapeJobsRouter: Router = Router();

// GET /api/scrape-jobs
scrapeJobsRouter.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db.select().from(scrapeJobs);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/scrape-jobs/:id
scrapeJobsRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, id));
    if (!row) {
      res.status(404).json({ error: "Scrape job not found" });
      return;
    }
    res.json(row);
  } catch (err) { next(err); }
});
