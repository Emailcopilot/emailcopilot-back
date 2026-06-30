import BrowserManager from "./browserManager";
import {
  installPlaywrightCloseGuard,
  WebsiteEmailCrawler,
} from "./scrapingWebsiteEmail";
import type { Browser, Locator, Page } from "playwright";

installPlaywrightCloseGuard();

export type GoogleMapsListing = {
  name: string | null;
  rating: string | null;
  reviewCount: string | null;
  category: string | null;
  addressSnippet: string | null;
  url: string | null;
  placeId: string | null;
  website: string | null;
  phone: string | null;
};

export type GoogleMapsListingWithEmail = GoogleMapsListing & {
  email: string | null;
};

export type GoogleMapsCard = Omit<GoogleMapsListing, "website" | "phone">;

type CardFeedFilter = (
  listing: GoogleMapsListing,
) => boolean | Promise<boolean>;

type FeedsListingFilter = (card: GoogleMapsCard) => boolean | Promise<boolean>;

type WebsiteFilter = (
  listing: GoogleMapsListingWithEmail,
) => boolean | Promise<boolean>;

type OnListingCallback = (
  listing: GoogleMapsListingWithEmail,
) => void | Promise<void>;

type ListGoogleMapsListingsOptions = {
  keyword: string;
  city: string;
  country: string;
  max?: number;
  browser: Browser;
  cardFeedFilter?: CardFeedFilter;
  feedsListingFilter?: FeedsListingFilter;
  websiteFilter?: WebsiteFilter;
  onListing?: OnListingCallback;
};

function buildSearchLocation(city: string, country: string) {
  return `${city}, ${country}`;
}

function buildSearchTerm(keyword: string, city: string, country: string) {
  return `${keyword} in ${buildSearchLocation(city, country)}`;
}

function parsePlaceNameFromUrl(url: string | null | undefined) {
  const match = url?.match(/\/maps\/place\/([^/@?]+)/);
  if (!match) return null;
  return decodeURIComponent(match[1].replace(/\+/g, " "));
}

function parsePlaceIdFromUrl(url: string | null | undefined) {
  const match = url?.match(/!19s([^!?&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function toAbsoluteMapsUrl(href: string | null) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  return `https://www.google.com${href.startsWith("/") ? href : `/${href}`}`;
}

async function dismissConsent(page: Page) {
  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("Reject all")',
    'button:has-text("Tout accepter")',
    'button:has-text("Tout refuser")',
    'button:has-text("I agree")',
    'form[action*="consent"] button',
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.isVisible({ timeout: 1500 }).catch(() => false)) {
      await button.click();
      await page.waitForTimeout(1000);
      return;
    }
  }
}

function cleanLabel(value: string | null, prefixes: string[]) {
  if (!value) return null;
  let cleaned = value.trim();
  for (const prefix of prefixes) {
    cleaned = cleaned.replace(new RegExp(`^${prefix}[:\\s]*`, "i"), "");
  }
  return cleaned.trim() || null;
}

async function scrapeDetailPanel(page: Page) {
  await page.waitForSelector('h1.DUwDvf, button[data-item-id="address"]', {
    timeout: 10000,
  });

  const getAttr = async (selector: string, attr: string) => {
    const el = page.locator(selector).first();
    return (await el.isVisible().catch(() => false))
      ? await el.getAttribute(attr)
      : null;
  };

  const phone = cleanLabel(
    (await getAttr('button[data-item-id^="phone:tel:"]', "aria-label")) ||
      (
        await getAttr('button[data-item-id^="phone:tel:"]', "data-item-id")
      )?.replace("phone:tel:", "") ||
      null,
    ["Phone", "Numéro de téléphone", "Telephone"],
  );

  const website = cleanLabel(
    (await getAttr('a[data-item-id="authority"]', "aria-label")) ||
      (await getAttr('a[data-item-id="authority"]', "href")),
    ["Website", "Site Web", "Site web"],
  );

  return { website, phone };
}

async function closeDetailPanel(page: Page) {
  const backButton = page.locator('button[aria-label="Back"]').first();
  if (await backButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await backButton.click();
    await page.waitForTimeout(500);
    return;
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
}

async function scrapeListingDetails(
  page: Page,
  link: Locator,
  card: GoogleMapsCard,
): Promise<Pick<GoogleMapsListing, "website" | "phone">> {
  try {
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await page.waitForTimeout(1500);
    const details = await scrapeDetailPanel(page);
    await closeDetailPanel(page);
    return details;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to scrape details (${card.name}): ${message}`);
    await closeDetailPanel(page).catch(() => {});
    return { website: null, phone: null };
  }
}

async function isEndOfList(page: Page) {
  return page
    .locator(
      '[role="feed"] span:has-text("end of list"), [role="feed"] span:has-text("You\'ve reached the end")',
    )
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

async function scrollFeedForMore(feed: Locator, page: Page) {
  await feed
    .click({ position: { x: 20, y: 200 }, force: true })
    .catch(() => {});

  for (let step = 0; step < 3; step++) {
    await feed.evaluate((el) => el.scrollBy(0, 1200)).catch(() => {});
    await page.waitForTimeout(400);
  }

  const lastLink = page
    .locator('div[role="feed"] a[href*="/maps/place/"]')
    .last();
  if ((await lastLink.count()) > 0) {
    await lastLink.scrollIntoViewIfNeeded().catch(() => {});
  }
}

async function isSponsoredListing(link: Locator): Promise<boolean> {
  return link
    .evaluate((el) => {
      const card =
        el.closest('[role="article"]') ??
        el.closest(".Nv2PK") ??
        el.parentElement?.parentElement;
      if (!card) return false;
      return /\bsponsored\b|\bannonce\b/i.test(card.textContent ?? "");
    })
    .catch(() => false);
}

async function enrichListingWithEmail(
  emailCrawler: WebsiteEmailCrawler,
  listing: GoogleMapsListing,
): Promise<GoogleMapsListingWithEmail> {
  if (!listing.website) {
    return { ...listing, email: null };
  }

  console.log(`Crawling email from ${listing.website}...`);
  try {
    const result = await emailCrawler.crawl({
      url: listing.website,
      businessName: listing.name,
    });

    if (result.email) {
      console.log(`  Found: ${result.email}`);
    } else {
      console.log(`  No email found`);
    }

    return { ...listing, email: result.email };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Email crawl failed for ${listing.website}: ${message}`);
    return { ...listing, email: null };
  }
}

async function collectFilteredListings(
  page: Page,
  emailCrawler: WebsiteEmailCrawler,
  max: number,
  cardFeedFilter?: CardFeedFilter,
  feedsListingFilter?: FeedsListingFilter,
  websiteFilter?: WebsiteFilter,
  onListing?: OnListingCallback,
) {
  const feed = page.locator('div[role="feed"]');
  await feed.waitFor({ state: "visible", timeout: 15000 });

  const hasFilter = cardFeedFilter || feedsListingFilter || websiteFilter;
  const maxScrolls = hasFilter
    ? Math.max(150, max * 20)
    : Math.max(50, max * 3);
  const maxStaleScrolls = hasFilter ? 25 : 10;
  const scrollWaitMs = hasFilter ? 2500 : 1500;

  const seen = new Set<string>();
  const listings: GoogleMapsListingWithEmail[] = [];
  let staleScrolls = 0;

  const scanAndCollectVisible = async () => {
    const links = page.locator('div[role="feed"] a[href*="/maps/place/"]');
    const total = await links.count();
    let newlyAccepted = 0;
    let newlySeen = 0;

    for (let i = 0; i < total && listings.length < max; i++) {
      if (page.isClosed()) {
        console.warn("Google Maps page closed, stopping scan");
        break;
      }

      const link = links.nth(i);
      const href = await link.getAttribute("href");
      if (!href || seen.has(href)) continue;

      await link.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(200);

      if (await isSponsoredListing(link)) {
        seen.add(href);
        newlySeen++;
        continue;
      }

      const card = await scrapeListingCard(link);
      seen.add(href);
      newlySeen++;

      if (feedsListingFilter && !(await feedsListingFilter(card))) continue;

      const needsDetailPanel = !!(cardFeedFilter || websiteFilter);
      const listing: GoogleMapsListing = needsDetailPanel
        ? { ...card, ...(await scrapeListingDetails(page, link, card)) }
        : { ...card, website: null, phone: null };

      if (cardFeedFilter && !(await cardFeedFilter(listing))) continue;

      const finalListing: GoogleMapsListingWithEmail = websiteFilter
        ? await enrichListingWithEmail(emailCrawler, listing)
        : { ...listing, email: null };

      if (websiteFilter && !(await websiteFilter(finalListing))) continue;

      listings.push(finalListing);
      newlyAccepted++;
      console.log(`[${listings.length}/${max}] ${finalListing.name}`);
      if (onListing) await onListing(finalListing);
    }

    return { newlyAccepted, newlySeen };
  };

  await scanAndCollectVisible();

  for (let scroll = 0; scroll < maxScrolls && listings.length < max; scroll++) {
    if (await isEndOfList(page)) {
      console.log(
        `Reached end of Google Maps list at ${listings.length}/${max}`,
      );
      break;
    }

    const prevSeenCount = seen.size;
    await scrollFeedForMore(feed, page);
    await page.waitForTimeout(scrollWaitMs);
    const { newlyAccepted, newlySeen } = await scanAndCollectVisible();

    if (newlySeen === 0) {
      staleScrolls++;
      if (staleScrolls % 5 === 0 && listings.length < max) {
        for (let burst = 0; burst < 4; burst++) {
          await feed.evaluate((el) => el.scrollBy(0, 2000)).catch(() => {});
          await page.waitForTimeout(600);
        }
      }
      if (staleScrolls >= maxStaleScrolls) {
        if (await isEndOfList(page)) {
          console.log(
            `Reached end of Google Maps list at ${listings.length}/${max}`,
          );
        } else {
          console.log(
            `Feed stopped loading after ${maxStaleScrolls} scrolls at ${listings.length}/${max} (${seen.size} scanned)`,
          );
        }
        break;
      }
    } else {
      staleScrolls = 0;
    }

    if (newlyAccepted > 0) {
      staleScrolls = 0;
    }

    if (scroll % 5 === 4) {
      console.log(
        `Scroll ${scroll + 1}/${maxScrolls}: ${listings.length}/${max} accepted, ${seen.size} scanned (+${seen.size - prevSeenCount} this round)`,
      );
    }
  }

  if (listings.length < max) {
    console.log(`Found ${listings.length} listing(s) (requested ${max})`);
  }

  return listings;
}

async function scrapeListingCard(link: Locator): Promise<GoogleMapsCard> {
  await link.scrollIntoViewIfNeeded().catch(() => {});
  const cardText = (await link.innerText()).trim();
  const lines = cardText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const href = await link.getAttribute("href");
  const url = toAbsoluteMapsUrl(href);

  return {
    name: lines[0] || parsePlaceNameFromUrl(href),
    rating: lines.find((line) => /^\d+(\.\d+)?$/.test(line)) || null,
    reviewCount:
      lines.find((line) => /^\([\d,]+\)$/.test(line))?.replace(/[()]/g, "") ||
      null,
    category:
      lines.find((line) => !/^\d|^\(|^·/.test(line) && line !== lines[0]) ||
      null,
    addressSnippet:
      lines.find((line) => line.includes("·") || /\d/.test(line)) || null,
    url,
    placeId: parsePlaceIdFromUrl(url),
  };
}

export async function listGoogleMapsListings({
  keyword,
  city,
  country,
  max = 20,
  browser,
  cardFeedFilter,
  feedsListingFilter,
  websiteFilter,
  onListing,
}: ListGoogleMapsListingsOptions): Promise<GoogleMapsListingWithEmail[]> {
  const searchTerm = buildSearchTerm(keyword, city, country);
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}?hl=en`;

  console.log(`Searching: ${searchTerm}`);
  console.log(`URL: ${searchUrl}`);

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();
  const emailCrawler = new WebsiteEmailCrawler(browser);

  try {
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await dismissConsent(page);
    await page.waitForTimeout(2000);

    return await collectFilteredListings(
      page,
      emailCrawler,
      max,
      cardFeedFilter,
      feedsListingFilter,
      websiteFilter,
      onListing,
    );
  } finally {
    await emailCrawler.close();
    await context.close();
  }
}

async function main() {
  const browserManager = new BrowserManager();
  const browser = await browserManager.getBrowser(false);
  const listings = await listGoogleMapsListings({
    keyword: "plumbing contractors",
    city: "San Francisco",
    country: "United States",
    max: 10,
    browser,
    cardFeedFilter: (listing) => {
      return !!listing.website;
    },
    feedsListingFilter: (card) => !!card.placeId,
    websiteFilter: (listing) => !!listing.email,
    onListing: (listing) => {
      console.log(listing);
    },
  });

  await browserManager.closeBrowser();
  console.log(`\nCollected ${listings.length} listing(s)`);
  console.log(JSON.stringify(listings, null, 2));
}

const isDirectRun = process.argv[1]?.endsWith("scraping.ts");
if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
