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
const RESULTS_PER_BATCH = 20;
const PERIODIC_RESTART_THRESHOLD = 15;
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
    .replace(/[_*]+/g, "") // Strip markdown artifacts (e.g. __ or **)
    .trim();
}

function cleanScrapedString(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[_*]+/g, "").trim(); // Strip markdown artifacts
  return cleaned || null; // Return null if empty after cleaning
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
  "sentry.io",
  "example.com",
  "wixpress.com",
  "squarespace.com",
  "wordpress.com",
  "google.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "tiktok.com",
  "youtube.com",
  "amazonaws.com",
  "cloudfront.net",
];

function extractEmails(text: string): string[] {
  return (text.match(EMAIL_REGEX) || []).filter(
    (email) =>
      !IGNORED_EMAIL_DOMAINS.some((domain) =>
        email.toLowerCase().endsWith(`@${domain}`),
      ),
  );
}

export async function findEmailOnWebsite(
  page: Page,
  website: string,
): Promise<string | null> {
  try {
    const url = website.startsWith("http") ? website : `https://${website}`;
    await page.goto(url, {
      timeout: SCRAPE_TIMEOUT,
      waitUntil: "domcontentloaded",
    });
    await randomDelay(1000, 2000);

    // @ts-ignore
    let bodyText = await page.evaluate(() => document.body.innerText);
    let emails = extractEmails(bodyText);
    // console.log({ emails });
    if (emails.length > 0) return emails[0];

    for (const path of [
      "/contact",
      "/contact-us",
      "/about",
      "/about-us",
      "/kontakt",
    ]) {
      try {
        await page.goto(`${url}${path}`, {
          timeout: SCRAPE_TIMEOUT,
          waitUntil: "domcontentloaded",
        });
        await randomDelay(800, 1500);
        // @ts-ignore
        bodyText = await page.evaluate(() => document.body.innerText);
        emails = extractEmails(bodyText);
        // console.log({ emails });
        if (emails.length > 0) return emails[0];
      } catch {
        continue;
      }
    }
    return null;
  } catch (error) {
    console.warn(
      `⚠️  Could not scrape website ${website}:`,
      (error as Error).message,
    );
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
  jobId: number,
): Promise<number> {
  const existingLeads = await db
    .select({ companyName: leads.companyName })
    .from(leads)
    .where(and(eq(leads.userId, userId), eq(leads.scrapeProfileId, profileId)));

  const seen = new Set(existingLeads.map((l) => l.companyName));
  console.log(
    `📋 Resuming job — ${seen.size} leads already saved for this job`,
  );

  // Google Maps shows all results in one scrollable feed per search.
  // We do ONE pass per job: open the page, scroll to the bottom, process every card.
  // A second batch only runs if we somehow hit the limit mid-scroll (rare with limit<=100).
  let page: Page | null = null;
  let batchCount = 0;

  while (seen.size < limit) {
    batchCount++;
    console.log(
      `\n🔄 ═══ Batch ${batchCount} starting — ${seen.size}/${limit} leads so far ═══`,
    );

    // Close previous page fully (its context too) before opening a fresh one
    if (page) {
      console.log(`  ↳ Closing previous page...`);
      try {
        await page.context().close();
      } catch {
        await page.close().catch(() => {});
      }
      page = null;
      // Brief pause so the browser process can fully clean up
      await delay(1500);
    }

    console.log(`  ↳ Opening new stealth page...`);
    page = await newStealthPage(browser);
    console.log(`  ↳ Page opened. Navigating to Maps...`);
    await initPage(page, query);
    console.log(`  ↳ Maps loaded. Starting processBatch...`);

    const sizeBeforeBatch = seen.size;
    const batchProcessed = await processBatch(
      page,
      seen,
      limit,
      userId,
      profileId,
      jobId,
      query,
    );

    console.log(
      `\n✅ Batch ${batchCount} complete — added ${batchProcessed} new leads (total seen: ${seen.size}/${limit})`,
    );

    // If nothing new was found this batch, Maps has no more results for this query
    if (seen.size === sizeBeforeBatch) {
      console.log(
        "🛑 No new leads found in this batch — Google Maps has no more results. Stopping.",
      );
      break;
    }

    // Periodic restart every N leads (even if limit not reached yet)
    if (
      seen.size > 0 &&
      seen.size % PERIODIC_RESTART_THRESHOLD === 0 &&
      seen.size < limit
    ) {
      console.log(
        `✅ Hit ${seen.size} leads — restarting browser for next batch...`,
      );
      await page?.close().catch(() => {});
      page = null; // Will trigger new page creation on next loop iteration
    }

    // Reached limit
    if (seen.size >= limit) {
      console.log(`🎯 Limit of ${limit} reached.`);
      break;
    }

    // More results needed — wait before next batch
    const waitMs = 5000 + Math.random() * 3000;
    console.log(
      `  ↳ Waiting ${Math.round(waitMs / 1000)}s before next batch...`,
    );
    await delay(waitMs);
  }

  console.log(`\n📊 scrapeGoogleMaps done — total unique seen: ${seen.size}`);
  if (page) {
    await page
      .context()
      .close()
      .catch(() => page!.close().catch(() => {}));
  }
  return seen.size;
}

async function initPage(page: Page, query: string) {
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  console.log(`🗺️  Searching Google Maps: "${query}"`);
  await page.goto(searchUrl, {
    timeout: SCRAPE_TIMEOUT,
    waitUntil: "networkidle",
  });
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
    } catch {}
  }
}

async function processBatch(
  page: Page,
  seen: Set<string>,
  limit: number,
  userId: number,
  profileId: number,
  jobId: number,
  query: string,
): Promise<number> {
  const resultsPanel = page.locator('[role="feed"]').first();
  let processed = 0;
  let lastCardCount = 0;
  let stalledScrolls = 0;
  const MAX_SCROLL_ATTEMPTS = 25; // enough for 100+ results with lazy loading

  console.log(
    `  ↳ [processBatch] Starting scroll loop (max ${MAX_SCROLL_ATTEMPTS} attempts, limit=${limit})`,
  );

  for (
    let attempt = 1;
    attempt <= MAX_SCROLL_ATTEMPTS && seen.size < limit;
    attempt++
  ) {
    console.log(
      `  ↳ [scroll ${attempt}/${MAX_SCROLL_ATTEMPTS}] seen=${seen.size}/${limit}, stalled=${stalledScrolls}`,
    );

    // Scroll down to trigger lazy loading
    await resultsPanel.evaluate((el) => el.scrollBy(0, 1500)).catch(() => {});
    await randomDelay(2000, 3500);

    // Check if Google Maps has shown the "end of results" sentinel
    const endOfList = await page
      .locator('[role="feed"] span:has-text("end of list")')
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (endOfList) {
      console.log(
        "  ↳ [scroll] Google Maps end-of-list sentinel detected — done scrolling.",
      );
      break;
    }

    // Detect scroll stall — card count not growing means we hit the bottom
    const currentCardCount = await page
      .locator('[role="feed"] > div')
      .count()
      .catch(() => 0);
    console.log(
      `  ↳ [scroll ${attempt}] card count: ${currentCardCount} (was ${lastCardCount})`,
    );

    if (currentCardCount === lastCardCount) {
      stalledScrolls++;
      if (stalledScrolls >= 3) {
        console.log(
          "  ↳ [scroll] Stalled 3x — no more cards loading. Done scrolling.",
        );
        break;
      }
    } else {
      stalledScrolls = 0;
      lastCardCount = currentCardCount;
    }

    // Occasional human-like mouse movement
    if (Math.random() > 0.7) {
      await page.mouse
        .move(500 + Math.random() * 300, 300 + Math.random() * 400, {
          steps: 10,
        })
        .catch(() => {});
    }

    // Process all visible cards
    const cards = await page
      .locator('[role="feed"] > div')
      .all()
      .catch(() => []);
    console.log(`  ↳ [scroll ${attempt}] processing ${cards.length} cards...`);

    for (const card of cards) {
      if (seen.size >= limit) {
        console.log(
          `  ↳ [cards] Reached limit (${seen.size}/${limit}) — stopping card loop.`,
        );
        break;
      }

      try {
        const nameEl = card.locator("a[aria-label]").first();

        // getAttribute with short timeout — stale/invisible cards return null quickly
        const name = await nameEl
          .getAttribute("aria-label", { timeout: 2000 })
          .catch(() => null);
        if (!name?.trim()) continue;
        const cleanName = name.trim();

        // Already processed in this session
        if (seen.has(cleanName)) continue;

        console.log(`  ↳ [card] Checking: "${cleanName}"`);

        // ── DB duplicate check BEFORE any click ──────────────────────────────
        // Check company name — no click needed if it already exists
        const existsByName = await db.query.leads.findFirst({
          where: and(
            eq(leads.companyName, cleanName),
            eq(leads.userId, userId),
          ),
        });
        if (existsByName) {
          console.log(
            `  ↳ [card] "${cleanName}" already in DB by name — skipping (no click)`,
          );
          seen.add(cleanName);
          continue;
        }

        // ── Click to open detail panel ────────────────────────────────────────
        console.log(`  ↳ [card] Clicking "${cleanName}"...`);
        await nameEl.click({ timeout: 5000 });
        // Wait for detail panel to settle — shorter than before, with a hard cap
        await randomDelay(2500, 4500);

        // ── Extract data with explicit short timeouts ─────────────────────────
        console.log(`  ↳ [card] Extracting details for "${cleanName}"...`);

        const rawWebsite = await page
          .locator('a[data-item-id="authority"]')
          .getAttribute("href", { timeout: 5000 })
          .catch(() => null);
        const website = cleanScrapedString(rawWebsite);

        const rawPhone = await page
          .locator('button[data-item-id^="phone"]')
          .textContent({ timeout: 5000 })
          .catch(() => null);
        const phone = cleanGoogleMapsText(rawPhone);

        const rawAddress = await page
          .locator('button[data-item-id="address"]')
          .textContent({ timeout: 5000 })
          .catch(() => null);
        const address = cleanGoogleMapsText(rawAddress);

        console.log(
          `  ↳ [card] "${cleanName}" — website=${website ?? "none"}, phone=${phone ?? "none"}`,
        );

        // ── Website duplicate check (unique constraint) ───────────────────────
        if (website) {
          const existsByWebsite = await db.query.leads.findFirst({
            where: and(eq(leads.website, website), eq(leads.userId, userId)),
          });
          if (existsByWebsite) {
            console.log(
              `  ↳ [card] Website ${website} already in DB (under "${existsByWebsite.companyName}") — skipping "${cleanName}"`,
            );
            seen.add(cleanName);
            continue;
          }
        }

        // ── Insert ────────────────────────────────────────────────────────────
        seen.add(cleanName);
        try {
          await db.insert(leads).values({
            userId,
            companyName: cleanName,
            email: null,
            website,
            phone: phone ?? null,
            address: address ?? null,
            sourceQuery: query,
            scrapeProfileId: profileId,
            scrapeJobId: jobId,
            status: "pending_email",
          });
          processed++;
          console.log(
            `  📌 Saved [${processed}]: "${cleanName}" ${website ? `(${website})` : "(no website)"}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          if (
            msg.toLowerCase().includes("unique") ||
            msg.toLowerCase().includes("duplicate")
          ) {
            console.warn(
              `  ⏭️  Unique constraint on insert — skipping "${cleanName}": ${msg}`,
            );
          } else {
            console.warn(
              `  ❌ Failed to save "${cleanName}": ${msg} error:`,
              err,
            );
          }
        }
      } catch (err) {
        console.warn(
          `  ⚠️  Error processing card: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }
  }

  console.log(
    `  ↳ [processBatch] Done. processed=${processed}, seen=${seen.size}`,
  );
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
  sendLimit?: number,
): Promise<ScrapeJob> {
  const query = adHocQuery ?? profile.searchQuery;
  const limit = sendLimit ?? DEFAULT_RESULTS_LIMIT;

  console.log(
    `🔍 Scrape job — profile: "${profile.name}", query: "${query}", limit: ${limit}`,
  );

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

  // Heartbeat: logs every 30s so we can tell if the job is alive or silently hung
  const heartbeat = setInterval(() => {
    console.log(
      `💓 [heartbeat] Job ${job.id} still running — ${new Date().toISOString()}`,
    );
  }, 30_000);

  try {
    console.log(`🚀 Launching browser...`);
    browser = await launchBrowser();
    console.log(`✅ Browser launched. Starting Maps scrape...`);

    const foundCount = await scrapeGoogleMaps(
      browser,
      query,
      limit,
      profile.userId,
      profile.id,
      job.id,
    );
    console.log(
      `\n📋 Maps scrape done — ${foundCount} listings found. Starting email extraction...`,
    );

    // Reuse the browser but open a fresh page for website crawling
    let emailPage = await newStealthPage(browser);

    const pendingLeads = await db.query.leads.findMany({
      where: and(
        eq(leads.userId, profile.userId),
        eq(leads.status, "pending_email"),
      ),
    });
    console.log(
      `📧 ${pendingLeads.length} leads to check for emails for jobId ${job.id}`,
    );

    for (let i = 0; i < pendingLeads.length; i++) {
      const lead = pendingLeads[i];
      console.log(
        `\n📧 [${i + 1}/${pendingLeads.length}] Processing: "${lead.companyName}"`,
      );

      if (!lead.website) {
        await db
          .update(leads)
          .set({ status: "failed" })
          .where(eq(leads.id, lead.id));
        console.log(`  ↳ No website — marking failed`);
        continue;
      }

      console.log(`  ↳ Scraping: ${lead.website}`);
      const email = await findEmailOnWebsite(emailPage, lead.website);

      if (!email) {
        await db
          .update(leads)
          .set({ status: "failed" })
          .where(eq(leads.id, lead.id));
        console.log(`  ↳ No email found — marking failed`);
        continue;
      }

      console.log(`  ↳ Found email: ${email} — checking for duplicates...`);
      const emailExists = await db.query.leads.findFirst({
        where: and(eq(leads.email, email), eq(leads.userId, profile.userId)),
      });
      if (emailExists) {
        await db
          .update(leads)
          .set({ status: "failed" })
          .where(eq(leads.id, lead.id));
        console.log(
          `  ↳ Email already in DB (lead #${emailExists.id}) — marking failed`,
        );
        continue;
      }

      await db
        .update(leads)
        .set({ email, status: "new" })
        .where(eq(leads.id, lead.id));

      newLeadsCount++;
      console.log(
        `  ✅ Saved: "${lead.companyName}" <${email}> (total: ${newLeadsCount})`,
      );
      await randomDelay(1200, 2500);
    }

    await db
      .update(scrapeJobs)
      .set({
        status: "done",
        leadsFound: newLeadsCount,
        finishedAt: new Date(),
      })
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
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    await db
      .update(scrapeJobs)
      .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
      .where(eq(scrapeJobs.id, job.id));
  } finally {
    clearInterval(heartbeat);
    console.log(`🔒 Closing browser...`);
    await browser
      ?.close()
      .catch((e) => console.warn(`⚠️  Browser close error: ${e}`));
    console.log(`🔒 Browser closed.`);
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
  return {
    data: jobs,
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

export async function getScrapeJob(id: number) {
  const job = await db.query.scrapeJobs.findFirst({
    where: eq(scrapeJobs.id, id),
    with: { leads: true },
  });
  if (!job)
    throw Object.assign(new Error("Job not found"), { statusCode: 404 });
  return job;
}
