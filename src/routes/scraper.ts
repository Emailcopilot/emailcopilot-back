import { Router, Request, Response } from "express";
import { scrapeJobs, settings } from "../db/schema";
import { eq, desc, count } from "drizzle-orm";
import { runScrapeJob } from "../services/scraper";
import { db } from "../db/drizzle";

export const scraperRouter: Router = Router();

// GET /scraper/jobs
scraperRouter.get("/jobs", async (req: Request, res: Response) => {
  try {
    const { page = "1", limit = "20" } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    const [jobs, [{ total }]] = await Promise.all([
      db.query.scrapeJobs.findMany({
        orderBy: desc(scrapeJobs.createdAt),
        limit: limitNum,
        offset,
        with: { leads: { columns: { id: true } } },
      }),
      db.select({ total: count() }).from(scrapeJobs),
    ]);

    res.json({
      data: jobs,
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error("Error fetching scrape jobs:", error);
    res.status(500).json({ error: "Failed to fetch scrape jobs" });
  }
});

// POST /scraper/trigger
scraperRouter.post("/trigger", async (req: Request, res: Response) => {
  try {
    const { query } = req.body;

    if (query) {
      await db
        .insert(settings)
        .values({ userId: req.body.userId, key: "scrape_query", value: query })
        .onConflictDoUpdate({ target: settings.key, set: { value: query, updatedAt: new Date() } });
    }

    runScrapeJob().catch(console.error);

    res.status(202).json({
      message: "Scrape job started. Check server logs or /scraper/jobs for progress.",
      query: query ?? "using saved query setting",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to trigger scrape job" });
  }
});

// GET /scraper/jobs/:id
scraperRouter.get("/jobs/:id", async (req: Request, res: Response) => {
  try {
    const job = await db.query.scrapeJobs.findFirst({
      where: eq(scrapeJobs.id, parseInt(req.params.id)),
      with: { leads: true },
    });

    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json(job);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch scrape job" });
  }
});