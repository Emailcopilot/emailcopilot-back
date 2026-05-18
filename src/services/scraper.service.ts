import { chromium as playwrightChromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { Browser, Page } from "playwright";
import { leads, scrapeJobs, scrapeProfiles } from "../db/schema";
import { eq, desc, count } from "drizzle-orm";
import { db } from "../db/drizzle";
import type { ScrapeProfile, ScrapeJob } from "../db/schema";
import type { ListJobsInput } from "../validators/scraper.validator";

// ─── Types ────────────────────────────────────────────────────────────────────
interface ScrapedLead {
  companyName: string;
  email: string;
  website?: string;
  phone?: string;
  address?: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────
const SCRAPE_TIMEOUT = 45_000;
const DEFAULT_RESULTS_LIMIT = 10;
const IS_PROD = process.env.NODE_ENV === "production";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min = 1500, max = 4000) =>
  delay(Math.floor(Math.random() * (max - min + 1)) + min);

playwrightChromium.use(stealth());

// ─── Browser helpers ──────────────────────────────────────────────────────────
async function launchBrowser(): Promise<Browser> {
  return playwrightChromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--disable-extensions",
      "--disable-software-rasterizer",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

async function newStealthPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    viewport: {
      width: 1280 + Math.floor(Math.random() * 200),
      height: 800 + Math.floor(Math.random() * 150),
    },
    locale: "en-US",
    timezoneId: "America/New_York",
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Chromium";v="134", "Not;A=Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  });

  const page = await context.newPage();

  await page.route("**/*", (route) => {
    if (["font", "media"].includes(route.request().resourceType())) {
      route.abort();
    } else {
      route.continue();
    }
  });

  await context.addInitScript(() => {
    // @ts-ignore
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-ignore
    window.chrome = { runtime: {}, loadTimes: () => ({}) };
    // @ts-ignore
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });

  return page;
}

// ─── Email extraction ─────────────────────────────────────────────────────────
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

const IGNORED_EMAIL_DOMAINS = [
  "sentry.io", "example.com", "wixpress.com", "squarespace.com", "wordpress.com",
  "google.com", "facebook.com", "instagram.com", "twitter.com", "tiktok.com",
  "youtube.com", "amazonaws.com", "cloudfront.net",
];

function extractEmails(text: string): string[] {
  return (text.match(EMAIL_REGEX) || []).filter(
    (email) =>
      !IGNORED_EMAIL_DOMAINS.some((domain) =>
        email.toLowerCase().endsWith(`@${domain}`)
      )
  );
}

async function findEmailOnWebsite(page: Page, website: string): Promise<string | null> {
  try {
    const url = website.startsWith("http") ? website : `https://${website}`;
    await page.goto(url, { timeout: SCRAPE_TIMEOUT, waitUntil: "domcontentloaded" });
    await randomDelay(1000, 2000);

    // @ts-ignore
    let bodyText = await page.evaluate(() => document.body.innerText);
    let emails = extractEmails(bodyText);
    if (emails.length > 0) return emails[0];

    for (const path of ["/contact", "/contact-us", "/about", "/about-us", "/kontakt"]) {
      try {
        await page.goto(`${url}${path}`, { timeout: SCRAPE_TIMEOUT, waitUntil: "domcontentloaded" });
        await randomDelay(800, 1500);
        // @ts-ignore
        bodyText = await page.evaluate(() => document.body.innerText);
        emails = extractEmails(bodyText);
        if (emails.length > 0) return emails[0];
      } catch {
        continue;
      }
    }
    return null;
  } catch (error) {
    console.warn(`⚠️  Could not scrape website ${website}:`, (error as Error).message);
    return null;
  }
}

// ─── Google Maps scraper ──────────────────────────────────────────────────────
async function scrapeGoogleMaps(
  page: Page,
  query: string,
  limit: number
): Promise<Omit<ScrapedLead, "email">[]> {
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  console.log(`🗺️  Searching Google Maps: "${query}", Limit: ${limit}`);
  await page.goto(searchUrl, { timeout: SCRAPE_TIMEOUT, waitUntil: "networkidle" });
  await randomDelay(3000, 5000);

  for (const selector of [
    'button:has-text("Accept all")',
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Tout accepter")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Accetta tutto")',
  ]) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await randomDelay(800, 1500);
        break;
      }
    } catch { }
  }

  const results: Omit<ScrapedLead, "email">[] = [];
  const seen = new Set<string>();
  const resultsPanel = page.locator('[role="feed"]').first();

  for (let attempt = 0; attempt < 6 && results.length < limit; attempt++) {
    await resultsPanel.evaluate((el) => el.scrollBy(0, 700)).catch(() => { });
    await randomDelay(1200, 2500);
    await page.mouse.move(600 + Math.random() * 200, 400 + Math.random() * 200);

    const cards = await page.locator('[role="feed"] > div').all();

    for (const card of cards) {
      if (results.length >= limit) break;
      try {
        const nameEl = card.locator("a[aria-label]").first();
        const name = (await nameEl.getAttribute("aria-label"))?.trim();
        if (!name || seen.has(name)) continue;

        await nameEl.click();
        await randomDelay(4000, 6500);

        const website = await page
          .locator('a[data-item-id="authority"]')
          .getAttribute("href")
          .catch(() => null);
        const phone = await page
          .locator('button[data-item-id^="phone"]')
          .textContent()
          .catch(() => null);
        const address = await page
          .locator('button[data-item-id="address"]')
          .textContent()
          .catch(() => null);

        seen.add(name);
        results.push({
          companyName: name,
          website: website?.trim() || undefined,
          phone: phone?.trim() || undefined,
          address: address?.trim() || undefined,
        });
        console.log(`📌 Found: ${name} ${website ? `(${website})` : "(no website)"}`);
      } catch {
        continue;
      }
    }
  }

  if (results.length === 0 && !IS_PROD) {
    const timestamp = Date.now();
    const fs = await import("fs");
    fs.mkdirSync("/app/debug", { recursive: true });
    await page.screenshot({ path: `/app/debug/maps-${timestamp}.png`, fullPage: true });
    fs.writeFileSync(`/app/debug/maps-${timestamp}.html`, await page.content());
    console.log(`📸 Debug artifacts saved: maps-${timestamp}`);
  }

  return results;
}

// ─── Core job ─────────────────────────────────────────────────────────────────

/**
 * Runs a scrape job driven by a ScrapeProfile.
 * All config (query, limit, userId, profileId) comes from the profile —
 * no more reading from the removed `settings` table.
 *
 * Pass `adHocQuery` to override the profile's searchQuery for one-off calls.
 */
export async function runScrapeJob(
  profile: ScrapeProfile,
  adHocQuery?: string,
  sendLimit?: number
): Promise<ScrapeJob> {
  const query = adHocQuery ?? profile.searchQuery;
  const limit = sendLimit ?? DEFAULT_RESULTS_LIMIT;

  console.log(`🔍 Scrape job — profile: "${profile.name}", query: "${query}", limit: ${limit}`);

  const [job] = await db
    .insert(scrapeJobs)
    .values({
      userId: profile.userId,
      scrapeProfileId: profile.id, // ✅ job is now linked to the profile that triggered it
      query,
      status: "running",
    })
    .returning();

  let browser: Browser | null = null;
  let newLeadsCount = 0;

  try {
    browser = await launchBrowser();
    const page = await newStealthPage(browser);
    const listings = await scrapeGoogleMaps(page, query, limit);
    console.log(`📋 Found ${listings.length} listings, extracting emails...`);

    for (const listing of listings) {
      const alreadyExists = listing.website
        ? await db.query.leads.findFirst({ where: eq(leads.website, listing.website) })
        : null;
      if (alreadyExists) {
        console.log(`⏭️  Skipping ${listing.companyName} — website already in DB`);
        continue;
      }

      let email: string | null = null;
      if (listing.website) {
        console.log(`🌐 Checking website for email: ${listing.website}`);
        email = await findEmailOnWebsite(page, listing.website);
      }

      if (!email) {
        console.log(`⚠️  No email found for ${listing.companyName} — skipping`);
        continue;
      }

      const emailExists = await db.query.leads.findFirst({ where: eq(leads.email, email) });
      if (emailExists) {
        console.log(`⏭️  Email ${email} already in DB — skipping`);
        continue;
      }

      await db.insert(leads).values({
        userId: profile.userId,      // ✅ leads are owned by the user who ran the profile
        companyName: listing.companyName,
        email,
        website: listing.website,
        phone: listing.phone,
        address: listing.address,
        sourceQuery: query,
        scrapeProfileId: profile.id, // ✅ direct FK — no join needed to filter by profile
        scrapeJobId: job.id,
        status: "new",
      });

      newLeadsCount++;
      console.log(`✅ Saved: ${listing.companyName} <${email}>`);
      await randomDelay(1500, 3000);
    }

    await db
      .update(scrapeJobs)
      .set({ status: "done", leadsFound: newLeadsCount, finishedAt: new Date() })
      .where(eq(scrapeJobs.id, job.id));

    // ✅ Keep resultsCount on the profile in sync
    await db
      .update(scrapeProfiles)
      .set({
        resultsCount: profile.resultsCount + newLeadsCount,
        updatedAt: new Date(),
      })
      .where(eq(scrapeProfiles.id, profile.id));

    console.log(`✅ Scrape job complete. ${newLeadsCount} new leads saved.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ Scrape job failed: ${message}`);
    await db
      .update(scrapeJobs)
      .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
      .where(eq(scrapeJobs.id, job.id));
  } finally {
    await browser?.close();
  }

  return job;
}

// ─── Public API (used by routes) ─────────────────────────────────────────────

export async function listScrapeJobs({ page, limit }: ListJobsInput) {
  const offset = (page - 1) * limit;
  const [jobs, [{ total }]] = await Promise.all([
    db.query.scrapeJobs.findMany({
      orderBy: desc(scrapeJobs.createdAt),
      limit,
      offset,
      with: { leads: { columns: { id: true } } },
    }),
    db.select({ total: count() }).from(scrapeJobs),
  ]);
  return { data: jobs, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

export async function getScrapeJob(id: number) {
  const job = await db.query.scrapeJobs.findFirst({
    where: eq(scrapeJobs.id, id),
    with: { leads: true },
  });
  if (!job) throw Object.assign(new Error("Job not found"), { statusCode: 404 });
  return job;
}


