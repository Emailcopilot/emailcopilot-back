import { chromium as playwrightChromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { Browser, Page } from "playwright";
import { leads, scrapeJobs, scrapeProfiles } from "../db/schema";
import { eq, desc, count, and } from "drizzle-orm";
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
const RESULTS_PER_BATCH = 10;
const IS_PROD = process.env.NODE_ENV === "production";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min = 1500, max = 4000) =>
  delay(Math.floor(Math.random() * (max - min + 1)) + min);

function cleanGoogleMapsText(text: string | null | undefined): string | null {
  if (!text) return null;

  return text
    .trim()
    .replace(/[\uE000-\uF8FF]/g, "") // Private Use Area
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // Zero-width spaces
    .replace(/\u202C|\u202D|\u202E/g, "") // Bidirectional text control
    .replace(/||||▶|►|•|▪|·/g, "") // Common icon characters
    .replace(/\s+/g, " ") // Normalize multiple spaces
    .trim();
}

playwrightChromium.use(stealth());

// ─── Browser helpers ──────────────────────────────────────────────────────────
async function launchBrowser(): Promise<Browser> {
  return playwrightChromium.launch({
    // headless trur in prod, false in dev for debugging (shows the browser)
    headless: IS_PROD,
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
    viewport: { width: 1366, height: 768 },
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

  await page.setDefaultNavigationTimeout(60000);
  await page.setDefaultTimeout(30000);

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
  browser: Browser,
  query: string,
  limit: number,
  userId: number,
  profileId: number,
  jobId: number
): Promise<number> {
  const existingLeads = await db
    .select({ companyName: leads.companyName })
    .from(leads)
    .where(eq(leads.scrapeJobId, jobId));

  const seen = new Set(existingLeads.map((l) => l.companyName));
  console.log(`📋 Starting with ${seen.size} already saved leads for this job`);

  // Use seen.size as the single source of truth — don't maintain a separate counter
  let page: Page | null = null;
  let batchCount = 0;

  while (seen.size < limit) {
    batchCount++;
    console.log(`🔄 Starting batch ${batchCount} (${seen.size}/${limit} leads so far)...`);

    // Always close the old page before opening a new one
    if (page) {
      await page.close().catch(() => { });
      page = null;
    }

    page = await newStealthPage(browser);

    // initPage navigates to a fresh Maps search URL each batch,
    // so scroll position always resets to the top
    await initPage(page, query);

    const sizeBeforeBatch = seen.size;
    const batchProcessed = await processBatch(page, seen, limit, userId, profileId, jobId, query);

    console.log(`✅ Batch ${batchCount} done — added ${batchProcessed} leads`);

    // If we didn't add anything new this batch, Maps has no more results
    if (seen.size === sizeBeforeBatch) {
      console.log("🛑 No new results found — stopping.");
      break;
    }

    await randomDelay(4000, 7000);
  }

  await page?.close().catch(() => { });
  return seen.size;
}

async function initPage(page: Page, query: string) {
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  console.log(`🗺️  Searching Google Maps: "${query}"`);
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
}

async function processBatch(
  page: Page,
  seen: Set<string>,
  limit: number,
  userId: number,
  profileId: number,
  jobId: number,
  query: string
): Promise<number> {
  const resultsPanel = page.locator('[role="feed"]').first();
  let processed = 0;
  let lastCardCount = 0;
  let stalledScrolls = 0;

  for (let attempt = 0; attempt < 8 && seen.size < limit; attempt++) {
    await resultsPanel.evaluate((el) => el.scrollBy(0, 1000)).catch(() => { });
    await randomDelay(2200, 3800);

    // Break early if the card list has stopped growing for 3 consecutive scrolls
    const currentCardCount = await page.locator('[role="feed"] > div').count().catch(() => 0);
    if (currentCardCount === lastCardCount) {
      stalledScrolls++;
      if (stalledScrolls >= 3) {
        console.log("📄 Reached end of results panel — stopping scroll.");
        break;
      }
    } else {
      stalledScrolls = 0;
      lastCardCount = currentCardCount;
    }

    if (Math.random() > 0.7) {
      await page.mouse
        .move(500 + Math.random() * 300, 300 + Math.random() * 400, { steps: 10 })
        .catch(() => { });
    }

    const cards = await page.locator('[role="feed"] > div').all().catch(() => []);

    for (const card of cards) {
      if (seen.size >= limit) break;

      try {
        const nameEl = card.locator("a[aria-label]").first();
        const name = (await nameEl.getAttribute("aria-label"))?.trim();

        if (!name || seen.has(name)) continue;

        const alreadyExists = await db.query.leads.findFirst({
          where: and(eq(leads.companyName, name), eq(leads.userId, userId)),
        });
        if (alreadyExists) {
          seen.add(name); // keep seen in sync so we don't re-check on next scroll
          continue;
        }

        await nameEl.click();
        await randomDelay(4500, 7000);

        const rawWebsite = await page
          .locator('a[data-item-id="authority"]')
          .getAttribute("href")
          .catch(() => null);
        const website = rawWebsite?.trim() || null;

        const phone = cleanGoogleMapsText(
          await page
            .locator('button[data-item-id^="phone"]')
            .textContent()
            .catch(() => null)
        );
        const address = cleanGoogleMapsText(
          await page
            .locator('button[data-item-id="address"]')
            .textContent()
            .catch(() => null)
        );

        // Check website uniqueness before inserting — website has a UNIQUE constraint
        // and a previous run may have already saved a different company at the same URL
        if (website) {
          const websiteExists = await db.query.leads.findFirst({
            where: eq(leads.website, website),
          });
          if (websiteExists) {
            console.log(`⏭️  Website ${website} already in DB (under "${websiteExists.companyName}") — skipping ${name}`);
            seen.add(name);
            continue;
          }
        }

        seen.add(name);
        processed++;

        try {
          await db.insert(leads).values({
            userId,
            companyName: name,
            email: null,
            website,
            phone: phone?.trim() || null,
            address: address?.trim() || null,
            sourceQuery: query,
            scrapeProfileId: profileId,
            scrapeJobId: jobId,
            status: "pending_email",
          });
          console.log(`📌 Saved: ${name} ${website ? `(${website})` : "(no website)"}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          // Gracefully handle any remaining unique-constraint races
          if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("duplicate")) {
            console.warn(`⏭️  Skipping ${name} — unique constraint: ${msg}`);
          } else {
            console.warn(`Failed to save ${name}:`, msg);
          }
        }
      } catch {
        continue;
      }
    }
  }

  return processed;
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
    const foundCount = await scrapeGoogleMaps(browser, query, limit, profile.userId, profile.id, job.id);
    console.log(`📋 Found ${foundCount} listings, extracting emails...`);

    const page = await newStealthPage(browser);

    const pendingLeads = await db.query.leads.findMany({
      where: and(eq(leads.scrapeJobId, job.id), eq(leads.status, "pending_email")),
      orderBy: desc(leads.scrapedAt),
    });

    for (const lead of pendingLeads) {
      if (!lead.website) {
        await db.update(leads).set({ status: "failed" }).where(eq(leads.id, lead.id));
        console.log(`⚠️  No website for ${lead.companyName} — skipping`);
        continue;
      }

      console.log(`🌐 Checking website for email: ${lead.website}`);
      const email = await findEmailOnWebsite(page, lead.website);

      if (!email) {
        await db.update(leads).set({ status: "failed" }).where(eq(leads.id, lead.id));
        console.log(`⚠️  No email found for ${lead.companyName}`);
        continue;
      }

      const emailExists = await db.query.leads.findFirst({
        where: and(eq(leads.email, email), eq(leads.userId, profile.userId)),
      });
      if (emailExists) {
        await db.update(leads).set({ status: "failed" }).where(eq(leads.id, lead.id));
        console.log(`⏭️  Email ${email} already in DB — skipping`);
        continue;
      }

      await db
        .update(leads)
        .set({ email, status: "new" })
        .where(eq(leads.id, lead.id));

      newLeadsCount++;
      console.log(`✅ Saved: ${lead.companyName} <${email}>`);
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