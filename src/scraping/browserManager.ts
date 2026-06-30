import { Browser } from "playwright";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(stealthPlugin());

class BrowserManager {
  private browser: Browser | null = null;

  async getBrowser(headless = true) {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless });
    }
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export default BrowserManager;
