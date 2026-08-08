import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { scrapeProfiles } from "../db/schema";
import { and, eq } from "drizzle-orm";
import type {
  CreateScrapeProfileInput,
  UpdateScrapeProfileInput,
} from "../validators/scrape-profile.validator";

export async function listScrapeProfiles(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const rows = await db
    .select()
    .from(scrapeProfiles)
    .where(eq(scrapeProfiles.userId, userId));
  res.json(rows);
}

export async function getScrapeProfile(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [row] = await db
    .select()
    .from(scrapeProfiles)
    .where(and(eq(scrapeProfiles.id, id), eq(scrapeProfiles.userId, userId)));
  if (!row)
    throw Object.assign(
      new Error("Scrape profile not found getScrapeProfile"),
      { statusCode: 404 },
    );
  res.json(row);
}

export async function createScrapeProfile(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const data = req.body as CreateScrapeProfileInput;

  const [created] = await db
    .insert(scrapeProfiles)
    .values({ ...data, userId })
    .returning();
  res.status(201).json(created);
}

export async function updateScrapeProfile(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;
  const data = req.body as UpdateScrapeProfileInput;

  const [updated] = await db
    .update(scrapeProfiles)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(scrapeProfiles.id, id), eq(scrapeProfiles.userId, userId)))
    .returning();
  if (!updated)
    throw Object.assign(
      new Error("Scrape profile not found updateScrapeProfile"),
      { statusCode: 404 },
    );
  res.json(updated);
}

export async function deleteScrapeProfile(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  await db
    .delete(scrapeProfiles)
    .where(and(eq(scrapeProfiles.id, id), eq(scrapeProfiles.userId, userId)));
  res.status(204).send();
}
