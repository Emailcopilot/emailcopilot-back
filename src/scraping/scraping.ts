import BrowserManager from "./browserManager";
import {
  ensurePlaywrightCloseGuard,
  shouldSkipWebsite,
  WebsiteEmailCrawler,
} from "./scrapingWebsiteEmail";
import type { Browser, Locator, Page } from "playwright";

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
  return [city.trim(), country.trim()].filter(Boolean).join(", ");
}

function buildSearchTerm(keyword: string, city: string, country: string) {
  const location = buildSearchLocation(city, country);
  const trimmedKeyword = keyword.trim();
  if (!location) return trimmedKeyword;
  return `${trimmedKeyword} in ${location}`;
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

function cleanMapsText(value: string | null | undefined) {
  if (!value) return null;
  return (
    value
      .trim()
      .replace(/[\uE000-\uF8FF]/g, "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u202C|\u202D|\u202E/g, "")
      .replace(/[▶►•▪·]/g, "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

function parseAddressFromCardLines(lines: string[]) {
  for (const line of lines.slice(1)) {
    if (/^\d+(\.\d+)?$/.test(line)) continue;
    if (/^\([\d,]+\)$/.test(line)) continue;
    if (/^(open|closes|closed)\b/i.test(line)) continue;

    if (line.includes("·")) {
      const addressPart = line
        .split("·")
        .map((part) => part.trim())
        .find((part) => /\d/.test(part) && /[a-zA-Z]{2,}/.test(part));
      if (addressPart) return addressPart;
      continue;
    }

    if ((/,/.test(line) || /^\d+/.test(line)) && /[a-zA-Z]{2,}/.test(line)) {
      return line;
    }
  }

  return null;
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

  const getText = async (selector: string) => {
    const el = page.locator(selector).first();
    return (await el.isVisible().catch(() => false))
      ? await el.textContent()
      : null;
  };

  const addressSnippet = cleanMapsText(
    cleanLabel(
      (await getText('button[data-item-id="address"]')) ||
        (await getAttr('button[data-item-id="address"]', "aria-label")),
      ["Address", "Adresse"],
    ),
  );

  return { website, phone, addressSnippet };
}

async function prepareFeedForInteraction(page: Page) {
  await page
    .addStyleTag({
      content: `
        div[role="feed"] img,
        div[role="feed"] .bfdHYd {
          pointer-events: none !important;
        }
      `,
    })
    .catch(() => {});
}

async function openListingDetail(page: Page, link: Locator) {
  await link.scrollIntoViewIfNeeded().catch(() => {});

  const clickStrategies = [
    () => link.click({ timeout: 8000 }),
    () => link.click({ force: true, timeout: 5000 }),
    () =>
      link.evaluate((el) => {
        (el as HTMLAnchorElement).click();
      }),
  ];

  for (const click of clickStrategies) {
    try {
      await click();
      return;
    } catch {
      continue;
    }
  }

  const href = await link.getAttribute("href");
  const placeUrl = toAbsoluteMapsUrl(href);
  if (!placeUrl) {
    throw new Error("Could not open listing detail panel");
  }

  await page.goto(placeUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
}

async function scrapeListingDetails(
  page: Page,
  link: Locator,
  card: GoogleMapsCard,
  searchUrl: string,
): Promise<Pick<GoogleMapsListing, "website" | "phone" | "addressSnippet">> {
  try {
    const urlBefore = page.url();
    await openListingDetail(page, link);
    await page.waitForTimeout(1500);
    const details = await scrapeDetailPanel(page);

    if (page.url() !== urlBefore) {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(1000);
      await page
        .locator('div[role="feed"]')
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(() => {});
      await prepareFeedForInteraction(page);
    }

    return details;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to scrape details (${card.name}): ${message}`);
    if (page.url() !== searchUrl) {
      await page
        .goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
        .catch(() => {});
      await page
        .locator('div[role="feed"]')
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(() => {});
      await prepareFeedForInteraction(page).catch(() => {});
    }
    return { website: null, phone: null, addressSnippet: null };
  }
}

async function scrollFeedForMore(feed: Locator, page: Page) {
  await feed.evaluate((el) => el.scrollTo(0, el.scrollHeight));

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

function stripSkippedWebsite(listing: GoogleMapsListing): GoogleMapsListing {
  if (listing.website && shouldSkipWebsite(listing.website)) {
    return { ...listing, website: null };
  }
  return listing;
}

async function enrichListingWithEmail(
  emailCrawler: WebsiteEmailCrawler,
  listing: GoogleMapsListing,
): Promise<GoogleMapsListingWithEmail> {
  if (!listing.website || shouldSkipWebsite(listing.website)) {
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
  searchUrl: string,
  cardFeedFilter?: CardFeedFilter,
  feedsListingFilter?: FeedsListingFilter,
  websiteFilter?: WebsiteFilter,
  onListing?: OnListingCallback,
) {
  const feed = page.locator('div[role="feed"]');
  await feed.waitFor({ state: "visible", timeout: 15000 });
  await prepareFeedForInteraction(page);

  const hasFilter = cardFeedFilter || feedsListingFilter || websiteFilter;
  const maxScrolls = hasFilter
    ? Math.max(50, max * 5)
    : Math.max(30, Math.ceil(max / 3));
  const maxStaleScrolls = 10;
  const scrollWaitMs = 1500;

  const seen = new Set<string>();
  const listings: GoogleMapsListingWithEmail[] = [];
  let staleScrolls = 0;

  const scanAndCollectVisible = async () => {
    const links = page.locator('div[role="feed"] a[href*="/maps/place/"]');
    const total = await links.count();
    let newlyAccepted = 0;

    for (let i = 0; i < total && listings.length < max; i++) {
      try {
        const link = links.nth(i);
        const href = await link
          .getAttribute("href", { timeout: LINK_ATTR_TIMEOUT_MS })
          .catch(() => null);
        if (!href || seen.has(href)) continue;
        seen.add(href);

        if (await isSponsoredListing(link)) continue;

        const card = await scrapeListingCard(link);

        if (feedsListingFilter && !(await feedsListingFilter(card))) continue;

        const needsWebsite = !!(cardFeedFilter || websiteFilter);
        let listing: GoogleMapsListing;
        if (needsWebsite) {
          const details = await scrapeListingDetails(
            page,
            link,
            card,
            searchUrl,
          );
          listing = {
            ...card,
            ...details,
            addressSnippet: details.addressSnippet ?? card.addressSnippet,
          };
        } else {
          listing = { ...card, website: null, phone: null };
        }

        listing = stripSkippedWebsite(listing);

        if (cardFeedFilter && !(await cardFeedFilter(listing))) continue;

        const finalListing: GoogleMapsListingWithEmail = websiteFilter
          ? await enrichListingWithEmail(emailCrawler, listing)
          : { ...listing, email: null };

        if (websiteFilter && !(await websiteFilter(finalListing))) continue;

        listings.push(finalListing);
        newlyAccepted++;
        console.log(`[${listings.length}/${max}] ${finalListing.name}`);
        if (onListing) await onListing(finalListing);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Skipping listing at index ${i}: ${message}`);
      }
    }

    return newlyAccepted;
  };

  await scanAndCollectVisible();

  for (let scroll = 0; scroll < maxScrolls && listings.length < max; scroll++) {
    const endReached = await page
      .locator('span:has-text("You\'ve reached the end of the list")')
      .isVisible()
      .catch(() => false);
    if (endReached) {
      console.log(
        `Reached end of Google Maps list at ${listings.length}/${max}`,
      );
      break;
    }

    const prevSeenCount = seen.size;
    await scrollFeedForMore(feed, page);
    await page.waitForTimeout(scrollWaitMs);
    const newlyAccepted = await scanAndCollectVisible();

    if (newlyAccepted === 0 && seen.size === prevSeenCount) {
      staleScrolls++;
      if (staleScrolls >= maxStaleScrolls) {
        console.log(
          `No new listings after ${maxStaleScrolls} scrolls, stopping at ${listings.length}/${max}`,
        );
        break;
      }
    } else {
      staleScrolls = 0;
    }
  }

  if (listings.length < max) {
    console.log(`Found ${listings.length} listing(s) (requested ${max})`);
  }

  return listings;
}

const LINK_ATTR_TIMEOUT_MS = 5000;

async function scrapeListingCard(link: Locator): Promise<GoogleMapsCard> {
  const cardText = ((await link.innerText({ timeout: LINK_ATTR_TIMEOUT_MS }).catch(() => "")) || "").trim();
  const lines = cardText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const href = await link.getAttribute("href", { timeout: LINK_ATTR_TIMEOUT_MS }).catch(() => null);
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
    addressSnippet: parseAddressFromCardLines(lines),
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

  ensurePlaywrightCloseGuard();

  const mapsContext = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: "en-US",
  });
  const page = await mapsContext.newPage();
  const emailContext = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const emailCrawler = new WebsiteEmailCrawler(emailContext, true);

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
      searchUrl,
      cardFeedFilter,
      feedsListingFilter,
      websiteFilter,
      onListing,
    );
  } finally {
    await emailCrawler.close();
    await mapsContext.close();
  }
}

async function main() {
  const browserManager = new BrowserManager();
  const browser = await browserManager.getBrowser(false);
  const listings = await listGoogleMapsListings({
    keyword: "coffee shops",
    city: "London",
    country: "United Kingdom",
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
  process.exit(0);
}

const isDirectRun =
  process.argv[1]?.endsWith("scraping.ts") ||
  process.argv[1]?.endsWith("scraping.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
