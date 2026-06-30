import { findEmailOnWebsite } from "../src/services/scraper.service";
// playwright-extra is a drop-in replacement for playwright,
// it augments the installed playwright with plugin functionality
import { chromium } from "playwright-extra";

// Load the stealth plugin and use defaults (all tricks to hide playwright usage)
// Note: playwright-extra is compatible with most puppeteer-extra plugins
import stealth from "puppeteer-extra-plugin-stealth";

// Add the plugin to playwright (any number of plugins can be added)
chromium.use(stealth());

const websites = [
  //   "https://huisartsendendungen.praktijkinfo.nl/",
  "http://www.hethuisartsenteam.nl/",
  "https://www.hethuisartsenteam.nl/praktijkinformatie/nassaulaan/",
  "http://www.huisartsenpost-amstelland.nl/",
  "https://praktijkzuidpunt.nl/",
  "https://www.huisartsvaartscherijn.nl/nl/",
  "https://huisartsenposttilburg.nl/",
  "https://jp-voeg-gevelrenovatie.nl/",
  "http://www.heinbouw.nl/contact/",
  "https://ps-renovatie.nl/",
  "https://www.baysolt.be/",
  "http://www.stucenrenovatiebedrijf.nl/",
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  for (const website of websites) {
    const email = await findEmailOnWebsite(page, website);
    console.log({ website, email });
  }
  await browser.close();
}

main();
