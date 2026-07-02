import { chromium as stealthChromium } from "playwright-extra";
import {
  chromium as plainChromium,
  type Browser,
  type BrowserContext,
} from "playwright";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import { readFileSync, writeFileSync } from "fs";

stealthChromium.use(stealthPlugin());

const PAGE_GOTO_TIMEOUT_MS = 20000;
const PAGE_EVALUATE_TIMEOUT_MS = 10000;
const SCRAPE_SINGLE_PAGE_TIMEOUT_MS = 25000;
const CONTEXT_CLOSE_DELAY_MS = 150;

const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const JUNK_EMAIL_PATTERNS = [
  /example\.com$/i,
  /domain\.com$/i,
  /yourdomain\.com$/i,
  /email@domain/i,
  /sentry\.io$/i,
  /wixpress\.com$/i,
  /wordpress\.com$/i,
  /schema\.org$/i,
  /googleapis\.com$/i,
  /gstatic\.com$/i,
  /w3\.org$/i,
  /github\.com$/i,
  /\.(png|jpe?g|gif|webp|svg|css|js)$/i,
  /noreply|no-reply|donotreply|mailer-daemon|postmaster@/i,
  /^test@/i,
  /^user@/i,
  /^name@/i,
  /^email@/i,
];

const CONTACT_LINK_PRIORITY = [
  {
    pattern: /contact|get-in-touch|reach-us|reach_us|connect-with-us/i,
    score: 100,
  },
  { pattern: /about|connect|support|inquiry|reserv/i, score: 60 },
  { pattern: /locations?/i, score: 20 },
];

const CONTACT_PATH_FALLBACKS = [
  "/contact",
  "/contact-us",
  "/contact/",
  "/contact-us/",
  "/about",
  "/about-us",
  "/about/",
];

const PREFERRED_LOCAL_PARTS = [
  "contact",
  "info",
  "hello",
  "reservations",
  "booking",
  "events",
  "inquiry",
  "support",
  "mail",
  "office",
  "team",
  "admin",
];

const DEFAULT_INPUT = "scraping2.json";
const DEFAULT_OUTPUT = "businesses_with_emails.json";
const DEFAULT_MAX_CONTACT_PAGES = 3;
const DEFAULT_MAX_CONTEXTS = 3;
const FETCH_TIMEOUT_MS = 15000;
const FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseArgs() {
  const args = process.argv.slice(2);
  let input = DEFAULT_INPUT;
  let output = DEFAULT_OUTPUT;
  let url = null;
  let headless = true;
  let maxContactPages = DEFAULT_MAX_CONTACT_PAGES;
  let maxContexts = DEFAULT_MAX_CONTEXTS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input" || arg === "-i") input = args[++i];
    else if (arg === "--output" || arg === "-o") output = args[++i];
    else if (arg === "--url" || arg === "-u") url = args[++i];
    else if (arg === "--headless") headless = true;
    else if (arg === "--no-headless") headless = false;
    else if (arg === "--max-contact-pages") maxContactPages = Number(args[++i]);
    else if (arg === "--max-contexts") maxContexts = Number(args[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scraping_website_email.js [options]

Scrape business emails from websites listed in a JSON file, or from a single URL.

Options:
  -u, --url <url>              Scrape a single website URL
  -i, --input <file>           Input JSON file with businesses (default: ${DEFAULT_INPUT})
  -o, --output <file>          Output JSON file (default: ${DEFAULT_OUTPUT})
      --max-contact-pages <n>  Max contact-related pages to visit per site (default: ${DEFAULT_MAX_CONTACT_PAGES})
      --max-contexts <n>       Max parallel browser contexts for batch scraping (default: ${DEFAULT_MAX_CONTEXTS})
      --headless               Run browser headless (default)
      --no-headless            Show browser window
  -h, --help                   Show this help

Examples:
  node scraping_website_email.js --url https://boucherieus.com
  node scraping_website_email.js -i scraping2.json -o businesses_with_emails.json
  node scraping_website_email.js -i businesses.json --max-contexts 5
  node scraping_website_email.js -i businesses.json --no-headless
`);
      process.exit(0);
    }
  }

  return { input, output, url, headless, maxContactPages, maxContexts };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchBrowser({ headless, useStealth = false }) {
  const launcher = useStealth ? stealthChromium : plainChromium;
  return launcher.launch({ headless });
}

function isPlaywrightCloseError(err) {
  const message = err?.message || String(err);
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed") ||
    message.includes("Context has been closed")
  );
}

function installPlaywrightCloseGuard() {
  process.on("unhandledRejection", (reason) => {
    if (isPlaywrightCloseError(reason)) return;
    throw reason;
  });
}

let closeGuardInstalled = false;

export function ensurePlaywrightCloseGuard() {
  if (closeGuardInstalled) return;
  closeGuardInstalled = true;
  installPlaywrightCloseGuard();
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function normalizeWebsiteUrl(rawUrl) {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

const SOCIAL_MEDIA_DOMAINS = new Set([
  "facebook.com",
  "fb.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "linkedin.com",
  "youtube.com",
  "youtu.be",
  "pinterest.com",
  "snapchat.com",
  "whatsapp.com",
  "t.me",
  "threads.net",
  "reddit.com",
  "tumblr.com",
  "flickr.com",
  "vk.com",
  "weibo.com",
]);

const BOOKING_PLATFORM_DOMAINS = new Set([
  "direct-book.com",
  "opentable.com",
  "opentable.co.uk",
  "resy.com",
  "bookatable.com",
  "sevenrooms.com",
  "toasttab.com",
  "thefork.com",
  "lafourchette.com",
  "quandoo.com",
  "yelp.com",
  "tripadvisor.com",
  "square.site",
  "linktr.ee",
  "maps.app.goo.gl",
  "goo.gl",
  "forms.gle",
  "order.online",
  "ubereats.com",
  "deliveroo.com",
  "just-eat.co.uk",
  "doordash.com",
  "grubhub.com",
]);

const SKIPPED_WEBSITE_DOMAINS = new Set([
  ...SOCIAL_MEDIA_DOMAINS,
  ...BOOKING_PLATFORM_DOMAINS,
]);

function matchesSkippedDomain(domain: string, skippedDomain: string) {
  return domain === skippedDomain || domain.endsWith(`.${skippedDomain}`);
}

export function shouldSkipWebsite(url: string | null | undefined) {
  const normalized = normalizeWebsiteUrl(url ?? "");
  const domain = getDomain(normalized ?? url ?? "");
  if (!domain) return false;

  for (const skippedDomain of SKIPPED_WEBSITE_DOMAINS) {
    if (matchesSkippedDomain(domain, skippedDomain)) {
      return true;
    }
  }

  return false;
}

export function isSocialMediaWebsite(url: string | null | undefined) {
  const normalized = normalizeWebsiteUrl(url ?? "");
  const domain = getDomain(normalized ?? url ?? "");
  if (!domain) return false;

  for (const socialDomain of SOCIAL_MEDIA_DOMAINS) {
    if (matchesSkippedDomain(domain, socialDomain)) {
      return true;
    }
  }

  return false;
}

function skippedWebsiteResult(url: string) {
  return {
    email: null,
    emails: [],
    url: normalizeWebsiteUrl(url) ?? url,
    error: "Skipped website",
    method: "skipped",
  };
}

function normalizeUrlKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${pathname}`.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

function decodeEmailCandidate(value) {
  if (!value) return null;
  let decoded = value.trim();
  decoded = decodeURIComponent(decoded.replace(/\+/g, " "));
  decoded = decoded.replace(/&#64;|&commat;|%40/gi, "@");
  decoded = decoded.replace(
    /\s*\[at\]\s*|\s*\(at\)\s*|\s*\{at\}\s*|\s+at\s+/gi,
    "@",
  );
  decoded = decoded.replace(
    /\s*\[dot\]\s*|\s*\(dot\)\s*|\s*\{dot\}\s*|\s+dot\s+/gi,
    ".",
  );
  decoded = decoded.replace(/\s+/g, "");
  const match = decoded.match(EMAIL_REGEX);
  return match ? match[0].toLowerCase() : null;
}

function isJunkEmail(email) {
  return JUNK_EMAIL_PATTERNS.some((pattern) => pattern.test(email));
}

function collectEmailsFromSources(...sources) {
  const emails = new Set();
  for (const source of sources) {
    if (!source) continue;
    const matches = String(source).match(EMAIL_REGEX) || [];
    for (const match of matches) {
      const email = decodeEmailCandidate(match);
      if (email && !isJunkEmail(email)) emails.add(email);
    }
  }
  return emails;
}

function scoreEmail(email, siteDomain, businessName = "") {
  let score = 0;
  const [localPart, domain = ""] = email.split("@");
  const normalizedBusiness = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  if (
    siteDomain &&
    (domain === siteDomain || domain.endsWith(`.${siteDomain}`))
  ) {
    score += 100;
  }

  if (PREFERRED_LOCAL_PARTS.includes(localPart)) score += 40;

  if (
    /^(contact|info|hello|reservations|booking|events|inquiry)$/.test(localPart)
  )
    score += 35;

  if (
    /^(contact|info|hello|reservations|booking|events|inquiry)/.test(localPart)
  )
    score += 20;

  if (/(gmail|yahoo|hotmail|outlook|icloud)\./i.test(domain)) score -= 15;

  if (localPart === "pr" || localPart.startsWith("pr@")) score -= 10;

  if (
    /^contact[_-]/.test(localPart) ||
    /[_-](nyc|dc|chicago|miami|la|sf|ny)$/i.test(localPart)
  ) {
    score -= 25;
  }

  if (normalizedBusiness) {
    const compactLocalPart = localPart.replace(/[^a-z0-9]+/g, "");
    const businessTokens = businessName
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4);
    const genericTokens = new Set([
      "restaurant",
      "boucherie",
      "kitchen",
      "grill",
      "cafe",
      "coffee",
      "pizza",
    ]);

    for (const token of businessTokens) {
      if (genericTokens.has(token)) continue;
      if (
        compactLocalPart.includes(token) ||
        token.includes(compactLocalPart)
      ) {
        score += 100;
        break;
      }
    }
  }

  return score;
}

function pickBestEmail(emails, siteDomain, businessName = "") {
  const sorted = [...emails].sort(
    (a, b) =>
      scoreEmail(b, siteDomain, businessName) -
      scoreEmail(a, siteDomain, businessName),
  );
  return sorted[0] ?? null;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitleFromHtml(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function extractLinksFromHtml(html, baseUrl) {
  const links = [];
  const anchorRegex = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    try {
      const href = new URL(match[1], baseUrl).toString();
      const text = match[2]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      links.push({ href, text });
    } catch {
      continue;
    }
  }

  return links;
}

function extractPageDataFromHtml(html, baseUrl) {
  const mailtoEmails = [];
  for (const match of html.matchAll(/href=["']mailto:([^"'?]+)/gi)) {
    mailtoEmails.push(match[1]);
  }

  const links = extractLinksFromHtml(html, baseUrl);
  const text = htmlToText(html);
  const title = extractTitleFromHtml(html);
  const emails = collectEmailsFromSources(
    mailtoEmails.join(" "),
    html,
    text,
    title,
  );

  return { emails, links, title, text };
}

async function fetchPageHtml(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const contentType = response.headers.get("content-type") || "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml")
    ) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  }
}

export async function fetchWebsiteEmail({
  url,
  maxContactPages = DEFAULT_MAX_CONTACT_PAGES,
  businessName = "",
}) {
  const startUrl = normalizeWebsiteUrl(url);
  if (!startUrl) {
    return {
      email: null,
      emails: [],
      url,
      error: "Invalid URL",
      method: "fetch",
    };
  }

  if (shouldSkipWebsite(startUrl)) {
    return {
      ...skippedWebsiteResult(startUrl),
      method: "fetch",
    };
  }

  const siteDomain = getDomain(startUrl);
  const allEmails = new Set();

  const homepageHtml = await fetchPageHtml(startUrl);
  if (!homepageHtml) {
    return {
      email: null,
      emails: [],
      url: startUrl,
      contactPagesVisited: [],
      method: "fetch",
    };
  }

  const homepage = extractPageDataFromHtml(homepageHtml, startUrl);
  for (const email of homepage.emails) allEmails.add(email);

  const contactLinks = findContactLinks(
    homepage.links,
    startUrl,
    maxContactPages,
  );
  const contactResults = await Promise.all(
    contactLinks.map(async (contactUrl) => {
      const html = await fetchPageHtml(contactUrl);
      return { contactUrl, html };
    }),
  );

  const contactPagesVisited = [];
  for (const { contactUrl, html } of contactResults) {
    if (!html) continue;
    contactPagesVisited.push(contactUrl);
    const { emails } = extractPageDataFromHtml(html, contactUrl);
    for (const email of emails) allEmails.add(email);
  }

  const emails = [...allEmails];
  const email = pickBestEmail(emails, siteDomain, businessName);

  return {
    email,
    emails,
    url: startUrl,
    contactPagesVisited,
    method: "fetch",
  };
}

async function dismissConsent(page) {
  try {
    if (page.isClosed()) return;

    const selectors = [
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("Reject all")',
      'button:has-text("I agree")',
      'button:has-text("Got it")',
      'form[action*="consent"] button',
    ];

    for (const selector of selectors) {
      if (page.isClosed()) return;
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
        await button.click().catch(() => {});
        await sleep(800);
        return;
      }
    }
  } catch {
    // Page may have navigated or closed mid-dismissal.
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("Operation timed out")), ms);
    }),
  ]);
}

async function extractEmailsFromPage(page) {
  if (page.isClosed()) {
    return { emails: new Set(), links: [] };
  }

  try {
    const pageData = (await withTimeout(
      page.evaluate(() => {
        const mailtoEmails = [];
        for (const anchor of document.querySelectorAll('a[href*="mailto:"]')) {
          const href = anchor.getAttribute("href") || "";
          mailtoEmails.push(href.replace(/^mailto:/i, "").split("?")[0]);
        }

        const links = [];
        for (const anchor of document.querySelectorAll("a[href]")) {
          links.push({
            href: anchor.href,
            text: (anchor.textContent || "").trim(),
          });
        }

        const html = document.documentElement.innerHTML;
        const maxHtmlLength = 500_000;

        return {
          mailtoEmails,
          links,
          html:
            html.length > maxHtmlLength ? html.slice(0, maxHtmlLength) : html,
          text: document.body?.innerText || "",
          title: document.title || "",
        };
      }),
      PAGE_EVALUATE_TIMEOUT_MS,
    )) as {
      mailtoEmails: string[];
      links: { href: string; text: string }[];
      html: string;
      text: string;
      title: string;
    };

    const emails = collectEmailsFromSources(
      pageData.mailtoEmails.join(" "),
      pageData.html,
      pageData.text,
      pageData.title,
    );

    return { emails, links: pageData.links };
  } catch {
    return { emails: new Set(), links: [] };
  }
}

function scoreContactLink(pathAndText) {
  let score = 0;
  for (const { pattern, score: patternScore } of CONTACT_LINK_PRIORITY) {
    if (pattern.test(pathAndText)) score = Math.max(score, patternScore);
  }
  return score;
}

function findContactLinks(links, baseUrl, maxContactPages) {
  const baseDomain = getDomain(baseUrl);
  const seen = new Set();
  const navLinks = [];

  for (const link of links) {
    if (!link.href) continue;

    let parsed;
    try {
      parsed = new URL(link.href);
    } catch {
      continue;
    }

    const linkDomain = getDomain(link.href);
    if (baseDomain && linkDomain && linkDomain !== baseDomain) continue;

    const pathAndText = `${parsed.pathname} ${link.text}`;
    const score = scoreContactLink(pathAndText);
    if (score === 0) continue;

    const normalized = parsed.toString();
    const key = normalizeUrlKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    navLinks.push({ url: normalized, score });
  }

  navLinks.sort((a, b) => b.score - a.score);

  const result = [];
  const resultSeen = new Set([normalizeUrlKey(baseUrl)]);

  const addUrl = (url) => {
    const key = normalizeUrlKey(url);
    if (resultSeen.has(key)) return;
    resultSeen.add(key);
    result.push(url);
  };

  for (const { url } of navLinks.slice(0, maxContactPages)) {
    addUrl(url);
  }

  if (result.length === 0) {
    const origin = new URL(baseUrl).origin;
    for (const path of CONTACT_PATH_FALLBACKS) {
      if (result.length >= maxContactPages) break;
      addUrl(`${origin}${path}`);
    }
  }

  return result;
}

async function safeClosePage(page) {
  if (!page || page.isClosed()) return;
  try {
    await page.close({ runBeforeUnload: false });
  } catch {
    // Ignore races while the browser/context is shutting down.
  }
}

async function safeCloseContext(context) {
  if (!context) return;

  try {
    for (const page of context.pages()) {
      await safeClosePage(page);
    }
    await sleep(CONTEXT_CLOSE_DELAY_MS);
    await context.close();
  } catch (err) {
    if (!isPlaywrightCloseError(err)) {
      // Context may already be gone after page cleanup failures.
    }
  }
}

async function safeCloseBrowser(browser) {
  if (!browser?.isConnected()) return;

  try {
    for (const context of browser.contexts()) {
      await safeCloseContext(context);
    }
    await sleep(CONTEXT_CLOSE_DELAY_MS);
    await browser.close();
  } catch (err) {
    if (!isPlaywrightCloseError(err)) {
      // Browser may already be gone after context cleanup failures.
    }
  }
}

async function visitPageSafely(page, url) {
  try {
    if (page.isClosed()) return false;

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_GOTO_TIMEOUT_MS,
    });
    if (page.isClosed()) return false;

    await dismissConsent(page);
    if (!page.isClosed()) await page.waitForTimeout(1200).catch(() => {});
    return !page.isClosed();
  } catch {
    return false;
  }
}

function dedupeUrls(urls: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const url of urls) {
    const key = normalizeUrlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(url);
  }

  return deduped;
}

async function scrapePagesInParallel(context, urls) {
  const uniqueUrls = dedupeUrls(urls);
  const results = [];
  for (const pageUrl of uniqueUrls) {
    results.push(await scrapeSinglePage(context, pageUrl));
  }
  return results;
}

async function scrapeSinglePage(context, url) {
  try {
    return await withTimeout(
      scrapeSinglePageInner(context, url),
      SCRAPE_SINGLE_PAGE_TIMEOUT_MS,
    );
  } catch {
    return { url, emails: new Set(), links: [], loaded: false };
  }
}

async function scrapeSinglePageInner(context, url) {
  let page;
  try {
    page = await context.newPage();
    const loaded = await visitPageSafely(page, url);
    if (!loaded) return { url, emails: new Set(), links: [], loaded: false };

    const { emails, links } = await extractEmailsFromPage(page);
    return { url, emails, links, loaded: true };
  } catch {
    return { url, emails: new Set(), links: [], loaded: false };
  } finally {
    await sleep(CONTEXT_CLOSE_DELAY_MS);
    await safeClosePage(page);
  }
}

async function scrapeWebsiteEmailWithPlaywright({
  context,
  url,
  maxContactPages = DEFAULT_MAX_CONTACT_PAGES,
  businessName = "",
}) {
  const startUrl = normalizeWebsiteUrl(url);
  if (!startUrl) {
    return {
      email: null,
      emails: [],
      url,
      error: "Invalid URL",
      method: "playwright",
    };
  }

  const siteDomain = getDomain(startUrl);
  const origin = new URL(startUrl).origin;
  const fallbackUrls = CONTACT_PATH_FALLBACKS.slice(0, maxContactPages).map(
    (path) => `${origin}${path}`,
  );

  const initialUrls = dedupeUrls([startUrl, ...fallbackUrls]);
  const initialResults = await scrapePagesInParallel(context, initialUrls);

  const homepage = initialResults.find(
    (result) => normalizeUrlKey(result.url) === normalizeUrlKey(startUrl),
  ) ?? { url: startUrl, emails: new Set(), links: [], loaded: false };

  const allEmails = new Set();
  const contactPagesVisited = [];
  const scrapedKeys = new Set();

  for (const result of initialResults) {
    if (!result.loaded) continue;
    scrapedKeys.add(normalizeUrlKey(result.url));
    if (normalizeUrlKey(result.url) !== normalizeUrlKey(startUrl)) {
      contactPagesVisited.push(result.url);
    }
    for (const email of result.emails) allEmails.add(email);
  }

  const navContacts = homepage.loaded
    ? findContactLinks(homepage.links, startUrl, maxContactPages)
    : [];
  const extraUrls = navContacts.filter(
    (contactUrl) => !scrapedKeys.has(normalizeUrlKey(contactUrl)),
  );
  const extraResults = await scrapePagesInParallel(context, extraUrls);

  for (const result of extraResults) {
    if (!result.loaded) continue;
    contactPagesVisited.push(result.url);
    for (const email of result.emails) allEmails.add(email);
  }

  const emails = [...allEmails];
  const email = pickBestEmail(emails, siteDomain, businessName);

  return {
    email,
    emails,
    url: startUrl,
    contactPagesVisited,
    method: "playwright",
  };
}

export async function scrapeWebsiteEmail({
  browser = null,
  context = null,
  headless = true,
  useStealth = false,
  url,
  maxContactPages = DEFAULT_MAX_CONTACT_PAGES,
  businessName = "",
}) {
  if (shouldSkipWebsite(url)) {
    return skippedWebsiteResult(url);
  }

  const fetchResult = await fetchWebsiteEmail({
    url,
    maxContactPages,
    businessName,
  });
  if (fetchResult.email) {
    return fetchResult;
  }

  const ownsContext = !context;
  const ownsBrowser = !browser && !context;
  let activeBrowser = browser;
  let activeContext = context;

  try {
    if (!activeContext) {
      if (!activeBrowser) {
        activeBrowser = await launchBrowser({ headless, useStealth });
      } else if (!activeBrowser.isConnected()) {
        return {
          email: null,
          emails: [],
          url: normalizeWebsiteUrl(url) ?? url,
          error: "Browser disconnected",
          method: "playwright",
        };
      }

      activeContext = await activeBrowser.newContext();
    }

    return await scrapeWebsiteEmailWithPlaywright({
      context: activeContext,
      url,
      maxContactPages,
      businessName,
    });
  } catch (err) {
    return {
      email: null,
      emails: [],
      url: normalizeWebsiteUrl(url) ?? url,
      error: err.message || String(err),
      method: "playwright",
    };
  } finally {
    if (ownsContext) {
      await safeCloseContext(activeContext);
    }
    if (ownsBrowser) {
      await safeCloseBrowser(activeBrowser);
    }
  }
}

export type WebsiteEmailResult = {
  email: string | null;
  emails: string[];
  url: string;
  error?: string;
  method?: string;
  contactPagesVisited?: string[];
};

type CrawlWebsiteEmailOptions = {
  browser?: Browser | null;
  context?: BrowserContext;
  url: string;
  businessName?: string | null;
  maxContactPages?: number;
};

export async function crawlWebsiteEmail({
  browser,
  context,
  url,
  businessName = "",
  maxContactPages = DEFAULT_MAX_CONTACT_PAGES,
}: CrawlWebsiteEmailOptions): Promise<WebsiteEmailResult> {
  const result = await scrapeWebsiteEmail({
    browser,
    context,
    url,
    maxContactPages,
    businessName: businessName ?? "",
  } as Parameters<typeof scrapeWebsiteEmail>[0]);

  return result as WebsiteEmailResult;
}

export class WebsiteEmailCrawler {
  private readonly cache = new Map<string, WebsiteEmailResult>();
  private readonly inFlight = new Map<string, Promise<WebsiteEmailResult>>();

  constructor(
    private readonly context: BrowserContext,
    private readonly ownsContext = false,
  ) {}

  private cacheKey(url: string) {
    return normalizeUrlKey(normalizeWebsiteUrl(url) ?? url);
  }

  async crawl({
    url,
    businessName = "",
    maxContactPages = DEFAULT_MAX_CONTACT_PAGES,
  }: Omit<
    CrawlWebsiteEmailOptions,
    "browser" | "context"
  >): Promise<WebsiteEmailResult> {
    const key = this.cacheKey(url);
    const cached = this.cache.get(key);
    if (cached) {
      console.log(`  Using cached email for ${url}`);
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const task = this.crawlUncached({
      url,
      businessName,
      maxContactPages,
    }).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, task);
    return task;
  }

  private async crawlUncached({
    url,
    businessName = "",
    maxContactPages = DEFAULT_MAX_CONTACT_PAGES,
  }: Omit<
    CrawlWebsiteEmailOptions,
    "browser" | "context"
  >): Promise<WebsiteEmailResult> {
    const result = await crawlWebsiteEmail({
      context: this.context,
      url,
      maxContactPages,
      businessName,
    });

    this.cache.set(this.cacheKey(url), result);
    return result;
  }

  async close() {
    await Promise.allSettled([...this.inFlight.values()]);
    this.inFlight.clear();
    if (this.ownsContext) {
      await safeCloseContext(this.context);
    }
  }
}

async function scrapeBusinesses({
  headless,
  input,
  output,
  maxContactPages,
  maxContexts,
}) {
  const raw = readFileSync(input, "utf8");
  const businesses = JSON.parse(raw);
  if (!Array.isArray(businesses)) {
    throw new Error(`Expected ${input} to contain a JSON array`);
  }

  const concurrency = Math.max(1, maxContexts || DEFAULT_MAX_CONTEXTS);
  console.log(
    `Scraping ${businesses.length} business(es) with up to ${concurrency} parallel context(s)...`,
  );

  const results = await mapWithConcurrency(
    businesses,
    concurrency,
    async (business, index) => {
      const website = business.website;
      const label = business.name || website || `Item ${index + 1}`;

      if (!website) {
        console.log(
          `[${index + 1}/${businesses.length}] ${label} — no website`,
        );
        return { ...business, email: null, emails: [] };
      }

      process.stdout.write(
        `[${index + 1}/${businesses.length}] ${label} — scraping ${website}... `,
      );
      let scraped;
      try {
        scraped = await scrapeWebsiteEmail({
          headless,
          useStealth: false,
          url: website,
          maxContactPages,
          businessName: business.name || "",
        });
      } catch (err) {
        scraped = {
          email: null,
          emails: [],
          url: website,
          error: err.message || String(err),
          method: "playwright",
        };
      }

      const status =
        scraped.error && !scraped.email
          ? `error (${scraped.error})`
          : `${scraped.email ?? "not found"}${scraped.method ? ` (${scraped.method})` : ""}`;
      console.log(status);

      return {
        ...business,
        email: scraped.email,
        emails: scraped.emails,
        website: scraped.url ?? website,
      };
    },
  );

  writeFileSync(output, JSON.stringify(results, null, 2), "utf8");
  const found = results.filter((item) => item.email).length;
  console.log(`\nSaved ${results.length} business(es) to ${output}`);
  console.log(`Found emails for ${found}/${results.length} business(es)`);
  return results;
}

async function scrapeSingleUrl({ headless, url, maxContactPages }) {
  const result = await scrapeWebsiteEmail({
    headless,
    useStealth: true,
    url,
    maxContactPages,
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  installPlaywrightCloseGuard();
  const options = parseArgs();

  if (options.url) {
    await scrapeSingleUrl(options);
    return;
  }

  await scrapeBusinesses(options);
}

const isDirectRun =
  process.argv[1]?.endsWith("scrapingWebsiteEmail.ts") ||
  process.argv[1]?.endsWith("scrapingWebsiteEmail.ts");
if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
