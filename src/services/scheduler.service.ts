import cron from "node-cron";
import { subscriptions, scrapeProfiles } from "../db/schema";
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

/**
 * Resolves the user's active subscription at job fire time.
 * Intentionally NOT cached at init — avoids a stale subscriptionId if the user
 * upgrades or changes plan between scheduler restarts.
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

/**
 * Loads all scrape profiles for the user and runs each one sequentially.
 * Sequential rather than parallel to avoid spinning up multiple browsers
 * simultaneously against Google Maps.
 */
async function runAllScrapeProfiles(userId: number): Promise<void> {
  const profiles = await db
    .select()
    .from(scrapeProfiles)
    .where(eq(scrapeProfiles.userId, userId));

  if (profiles.length === 0) {
    console.log(`📭 No scrape profiles found for user ${userId} — skipping`);
    return;
  }

  console.log(`🔍 Running ${profiles.length} scrape profile(s) for user ${userId}`);

  for (const profile of profiles) {
    try {
      console.log(`   ▶ Profile "${profile.name}" (query: "${profile.searchQuery}")`);
      await runScrapeJob(profile);
    } catch (err) {
      // One failing profile must not abort the rest
      console.error(`   ❌ Profile "${profile.name}" failed:`, err);
    }
  }
}

function stopAll() {
  state.sendJob?.stop();
  state.scrapeJobAM?.stop();
  state.scrapeJobPM?.stop();
  state.sendJob = null;
  state.scrapeJobAM = null;
  state.scrapeJobPM = null;
}

function atHour(hour: string): string {
  return `0 ${hour} * * *`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialises cron jobs for a user.
 *
 * Schedules are currently hardcoded defaults. Replace the constants with a
 * per-user DB lookup once you have a user-preferences table.
 *
 * Send:   09:00 daily
 * Scrape: 08:00 and 14:00 daily
 */
export async function initScheduler(userId: number): Promise<void> {
  console.log(`⏰ Initialising scheduler for user ${userId}...`);
  stopAll();

  // ── Send job ────────────────────────────────────────────────────────────────
  const SEND_HOUR = "9";

  state.sendJob = cron.schedule(atHour(SEND_HOUR), async () => {
    console.log(`\n📧 [${new Date().toISOString()}] Send job triggered for user ${userId}`);
    try {
      const sub = await getActiveSubscription(userId);
      await runDailySendJob(userId, sub.id);
    } catch (e) {
      console.error("❌ Send job error:", e);
    }
  });
  console.log(`   ✅ Send job at ${SEND_HOUR}:00 daily`);

  // ── Scrape jobs ─────────────────────────────────────────────────────────────
  const AM_HOUR = "8";
  const PM_HOUR = "14";

  state.scrapeJobAM = cron.schedule(atHour(AM_HOUR), async () => {
    console.log(`\n🔍 [${new Date().toISOString()}] AM scrape triggered for user ${userId}`);
    await runAllScrapeProfiles(userId).catch((e) =>
      console.error("❌ AM scrape error:", e)
    );
  });
  console.log(`   ✅ AM scrape at ${AM_HOUR}:00 daily`);

  state.scrapeJobPM = cron.schedule(atHour(PM_HOUR), async () => {
    console.log(`\n🔍 [${new Date().toISOString()}] PM scrape triggered for user ${userId}`);
    await runAllScrapeProfiles(userId).catch((e) =>
      console.error("❌ PM scrape error:", e)
    );
  });
  console.log(`   ✅ PM scrape at ${PM_HOUR}:00 daily`);

  console.log("⏰ Scheduler ready.\n");
}

export async function restartScheduler(userId: number): Promise<void> {
  console.log(`🔄 Restarting scheduler for user ${userId}...`);
  await initScheduler(userId);
}

export function getSchedulerStatus() {
  return {
    sendJob: { active: state.sendJob !== null },
    scrapeJobAM: { active: state.scrapeJobAM !== null },
    scrapeJobPM: { active: state.scrapeJobPM !== null },
  };
}