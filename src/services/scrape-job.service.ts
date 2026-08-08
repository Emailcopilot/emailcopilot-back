import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { scrapeJobsTable } from "../db/schema";
import { eq } from "drizzle-orm";

export async function listScrapeJobs(_req: Request, res: Response) {
  const rows = await db.select().from(scrapeJobsTable);
  res.json(rows);
}

export async function getScrapeJob(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  const [row] = await db.select().from(scrapeJobsTable).where(eq(scrapeJobsTable.id, id));
  if (!row)
    throw Object.assign(new Error("Scrape job not found"), { statusCode: 404 });
  res.json(row);
}
