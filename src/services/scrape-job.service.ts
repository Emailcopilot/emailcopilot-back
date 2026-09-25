import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { scrapeJobsTable } from "../db/schema";
import { desc, eq } from "drizzle-orm";
import { notFound } from "../lib/http-error";

export async function listScrapeJobs(_req: Request, res: Response) {
  const rows = await db
    .select()
    .from(scrapeJobsTable)
    .orderBy(desc(scrapeJobsTable.createdAt));
  res.json(rows);
}

export async function getScrapeJob(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  const [row] = await db.select().from(scrapeJobsTable).where(eq(scrapeJobsTable.id, id));
  if (!row)
    throw notFound("Scrape job not found");
  res.json(row);
}
