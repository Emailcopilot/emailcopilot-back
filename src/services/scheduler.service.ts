import cron from "node-cron";
import { settings, subscriptions } from "../db/schema";
import { desc, eq } from "drizzle-orm";
import { runDailySendJob } from "./mailer.service";
import { runScrapeJob } from "./scraper.service";
import { db } from "../db/drizzle";

// ─── State ────────────────────────────────────────────────────────────────────
interface SchedulerState {
  sendJob: cron.ScheduledTask | null;
  scrapeJobAM: cron.ScheduledTask | null;
  scrapeJobPM: cron.ScheduledTask | null;
}

const state: SchedulerState = {
  sendJob: null,
  scrapeJobAM: null,
  scrapeJobPM: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  return (row?.value as string) ?? fallback;
}

/**
 * Resolves the active subscription at the moment the job fires.
 * This avoids baking a stale subscriptionId into the closure at init time.
 */
async function getActiveSubscription(userId: number) {
  const subs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt));
  const sub = subs[0];
  if (!sub) throw new Error(`No active subscription for user ${userId}`);
  return sub;
}

function stopAll() {
  state.sendJob?.stop();
  state.scrapeJobAM?.stop();
  state.scrapeJobPM?.stop();
  state.sendJob = null;
  state.scrapeJobAM = null;
  state.scrapeJobPM = null;
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function initScheduler(userId: number): Promise<void> {
  console.log("⏰ Initialising scheduler...");
  stopAll();

  const sendHour = await getSetting("send_hour", "9");
  const scrapeHours = await getSetting("scrape_hours", "8,14");
  const [amHour, pmHour] = scrapeHours.split(",").map((h) => h.trim());

  // ✅ FIX: Resolve subscription at fire time, not at init time
  state.sendJob = cron.schedule(`0 ${sendHour} * * *`, async () => {
    console.log(`\n📧 [${new Date().toISOString()}] Send job triggered`);
    try {
      const sub = await getActiveSubscription(userId);
      await runDailySendJob(userId, sub.id);
    } catch (e) {
      console.error("❌ Send job error:", e);
    }
  });
  console.log(`   ✅ Send job at ${sendHour}:00 daily`);

  if (amHour) {
    state.scrapeJobAM = cron.schedule(`0 ${amHour} * * *`, async () => {
      console.log(`\n🔍 AM scrape triggered`);
      await runScrapeJob().catch((e) => console.error("❌ AM scrape error:", e));
    });
    console.log(`   ✅ AM scrape at ${amHour}:00 daily`);
  }

  if (pmHour) {
    state.scrapeJobPM = cron.schedule(`0 ${pmHour} * * *`, async () => {
      console.log(`\n🔍 PM scrape triggered`);
      await runScrapeJob().catch((e) => console.error("❌ PM scrape error:", e));
    });
    console.log(`   ✅ PM scrape at ${pmHour}:00 daily`);
  }

  console.log("⏰ Scheduler ready.\n");
}

export async function restartScheduler(userId: number): Promise<void> {
  console.log("🔄 Restarting scheduler...");
  await initScheduler(userId);
}

export function getSchedulerStatus() {
  return {
    sendJob: { active: state.sendJob !== null },
    scrapeJobAM: { active: state.scrapeJobAM !== null },
    scrapeJobPM: { active: state.scrapeJobPM !== null },
  };
}
