import { db } from "../db/drizzle";
import { scrapeProfiles } from "../db/schema";
import { and, eq } from "drizzle-orm";
import type {
  CreateScrapeProfileInput,
  UpdateScrapeProfileInput,
} from "../validators/scrape-profile.validator";

export async function listScrapeProfiles(userId: number) {
  return db.select().from(scrapeProfiles).where(eq(scrapeProfiles.userId, userId));
}

export async function getScrapeProfile(id: number, userId: number) {
  // ✅ Fixed: was using `&&` (JS boolean AND) instead of Drizzle's `and()` —
  //    the userId condition was silently ignored before
  const [row] = await db
    .select()
    .from(scrapeProfiles)
    .where(and(eq(scrapeProfiles.id, id), eq(scrapeProfiles.userId, userId)));
  if (!row) throw Object.assign(new Error("Scrape profile not found getScrapeProfile"), { statusCode: 404 });
  return row;
}

export async function createScrapeProfile(userId: number, data: CreateScrapeProfileInput) {
  const [created] = await db
    .insert(scrapeProfiles)
    .values({ ...data, userId })
    .returning();
  return created;
}

export async function updateScrapeProfile(
  id: number,
  userId: number,
  data: UpdateScrapeProfileInput
) {
  // ✅ Fixed: same and() bug
  const [updated] = await db
    .update(scrapeProfiles)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(scrapeProfiles.id, id), eq(scrapeProfiles.userId, userId)))
    .returning();
  if (!updated) throw Object.assign(new Error("Scrape profile not found updateScrapeProfile"), { statusCode: 404 });
  return updated;
}

export async function deleteScrapeProfile(id: number, userId: number) {
  await db
    .delete(scrapeProfiles)
    .where(and(eq(scrapeProfiles.id, id), eq(scrapeProfiles.userId, userId)));
}
