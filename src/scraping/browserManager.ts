import { Browser } from "playwright";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(stealthPlugin());

class BrowserManager {
  private browser: Browser | null = null;

  async getBrowser(headless = true) {
    if (!this.browser) {
      const headed = process.env.PLAYWRIGHT_HEADED === "true";
      this.browser = await chromium.launch({
        headless: headed ? false : headless,
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
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async restartBrowser(headless = true) {
    console.log("🔄 Restarting browser...");
    await this.closeBrowser();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return this.getBrowser(headless);
  }
}

export default BrowserManager;
