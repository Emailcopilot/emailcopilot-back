import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { scrapeProfilesTable } from "../db/schema";
import { and, eq } from "drizzle-orm";
import type {
  CreateScrapeProfileInput,
  UpdateScrapeProfileInput,
} from "../validators/scrape-profile.validator";

export async function listScrapeProfiles(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const rows = await db
    .select()
    .from(scrapeProfilesTable)
    .where(eq(scrapeProfilesTable.userId, userId));
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
    .from(scrapeProfilesTable)
    .where(and(eq(scrapeProfilesTable.id, id), eq(scrapeProfilesTable.userId, userId)));
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
    .insert(scrapeProfilesTable)
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
    .update(scrapeProfilesTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(scrapeProfilesTable.id, id), eq(scrapeProfilesTable.userId, userId)))
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
    .delete(scrapeProfilesTable)
    .where(and(eq(scrapeProfilesTable.id, id), eq(scrapeProfilesTable.userId, userId)));
  res.status(204).send();
}
