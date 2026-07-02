import { db } from "../db/drizzle";
import {
  copilots,
  copilotLeadsTable,
  scrapeJobs,
  subscriptions,
} from "../db/schema";
import type { Copilot } from "../db/schema";
import { and, asc, count, desc, eq, gte } from "drizzle-orm";
import { getPlan } from "../routes/billing";

export const monthStart = () =>
  new Date(new Date().getFullYear(), new Date().getMonth(), 1);

export const dayStart = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start;
};

export type SubscriptionInfo = {
  planId: string;
  maxEmailsPerMonth: number;
  totalEmailsSent: number;
  remainingEmails: number;
};

export type CopilotProgress = {
  sentTodayCount: number;
  newLeadCount: number;
  dailySendLimit: number;
  remainingToday: number;
  dailyLimitReached: boolean;
  scrapeNeeded: number;
};

export async function getCopilotSentTodayCount(
  copilotId: number,
): Promise<number> {
  const [{ count: sentToday }] = await db
    .select({ count: count() })
    .from(copilotLeadsTable)
    .where(
      and(
        eq(copilotLeadsTable.copilotId, copilotId),
        eq(copilotLeadsTable.status, "sent"),
        gte(copilotLeadsTable.sentAt, dayStart()),
      ),
    );

  return sentToday;
}

export async function getActiveSubscription(
  userId: number,
): Promise<SubscriptionInfo | null> {
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  if (!subscription || subscription.status !== "active") {
    return null;
  }

  if (
    subscription.currentPeriodEnd &&
    subscription.currentPeriodEnd < new Date()
  ) {
    return null;
  }

  const plan = getPlan(subscription.planId);
  if (!plan) {
    return null;
  }

  const [{ count: totalEmailsSent }] = await db
    .select({ count: count() })
    .from(copilotLeadsTable)
    .leftJoin(copilots, eq(copilotLeadsTable.copilotId, copilots.id))
    .where(
      and(
        eq(copilots.userId, userId),
        eq(copilotLeadsTable.status, "sent"),
        gte(copilotLeadsTable.sentAt, monthStart()),
      ),
    );

  const remainingEmails = Math.max(0, plan.maxEmailsPerMonth - totalEmailsSent);

  return {
    planId: subscription.planId,
    maxEmailsPerMonth: plan.maxEmailsPerMonth,
    totalEmailsSent,
    remainingEmails,
  };
}

export async function getCopilotNewLeadCount(
  copilotId: number,
): Promise<number> {
  return db.$count(
    copilotLeadsTable,
    and(
      eq(copilotLeadsTable.copilotId, copilotId),
      eq(copilotLeadsTable.status, "new"),
    ),
  );
}

export async function getCopilotProgress(
  copilot: Copilot,
  subscription: SubscriptionInfo,
): Promise<CopilotProgress> {
  const sentTodayCount = await getCopilotSentTodayCount(copilot.id);
  const newLeadCount = await getCopilotNewLeadCount(copilot.id);
  const dailySendLimit = copilot.sendLimit;
  const remainingToday = Math.max(0, dailySendLimit - sentTodayCount);
  const dailyLimitReached = remainingToday <= 0;
  const scrapeBudget = Math.min(subscription.remainingEmails, remainingToday);
  const scrapeNeeded = Math.max(0, scrapeBudget - newLeadCount);

  return {
    sentTodayCount,
    newLeadCount,
    dailySendLimit,
    remainingToday,
    dailyLimitReached,
    scrapeNeeded,
  };
}

export function copilotNeedsMoreWork(progress: CopilotProgress): boolean {
  return !progress.dailyLimitReached && progress.remainingToday > 0;
}

const DAILY_LIMIT_MSG =
  "Daily send limit reached — will resume when quota resets";

export async function setCopilotActive(copilotId: number, reason?: string) {
  await db
    .update(copilots)
    .set({
      status: "active",
      lastError: reason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(copilots.id, copilotId));
  console.log(
    `🔄 Copilot ${copilotId} set to active${reason ? `: ${reason}` : ""}`,
  );
}

export async function setCopilotRunning(copilotId: number): Promise<Copilot> {
  const [running] = await db
    .update(copilots)
    .set({ status: "running", lastError: null, updatedAt: new Date() })
    .where(eq(copilots.id, copilotId))
    .returning();

  console.log(`🚀 Copilot ${copilotId} set to running`);
  return running;
}

/** Demote running copilots at daily limit → active; promote active with quota → running. */
export async function syncCopilotsDailyStatus(): Promise<Copilot | null> {
  const runningCopilots = await getRunningCopilots();

  for (const copilot of runningCopilots) {
    const subscription = await getActiveSubscription(copilot.userId);
    if (!subscription) {
      continue;
    }

    const progress = await getCopilotProgress(copilot, subscription);

    if (progress.dailyLimitReached) {
      await setCopilotActive(copilot.id, DAILY_LIMIT_MSG);
    }
  }

  const activeCopilots = await db
    .select()
    .from(copilots)
    .where(eq(copilots.status, "active"))
    .orderBy(asc(copilots.updatedAt));

  for (const copilot of activeCopilots) {
    const subscription = await getActiveSubscription(copilot.userId);
    if (!subscription || subscription.remainingEmails <= 0) {
      continue;
    }

    const progress = await getCopilotProgress(copilot, subscription);

    if (!progress.dailyLimitReached && progress.remainingToday > 0) {
      return setCopilotRunning(copilot.id);
    }
  }

  const stillRunning = await getRunningCopilots();

  for (const copilot of stillRunning) {
    const subscription = await getActiveSubscription(copilot.userId);
    if (!subscription || subscription.remainingEmails <= 0) {
      continue;
    }

    const progress = await getCopilotProgress(copilot, subscription);

    if (!progress.dailyLimitReached) {
      return copilot;
    }
  }

  return null;
}

export async function pauseCopilot(copilotId: number, reason: string) {
  await db
    .update(copilots)
    .set({
      status: "paused",
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(eq(copilots.id, copilotId));
  console.log(`⏸️  Copilot ${copilotId} paused: ${reason}`);
}

export async function completeCopilot(copilotId: number) {
  await db
    .update(copilots)
    .set({
      status: "completed",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(copilots.id, copilotId));
  console.log(`✅ Copilot ${copilotId} completed`);
}

export async function reactivateCopilot(copilotId: number, reason?: string) {
  await setCopilotActive(copilotId, reason);
}

export async function promoteActiveCopilot(): Promise<Copilot | null> {
  return syncCopilotsDailyStatus();
}

export async function resolveCopilotWithPendingScrapeJob(): Promise<Copilot | null> {
  const [row] = await db
    .select({ copilot: copilots })
    .from(scrapeJobs)
    .innerJoin(
      copilots,
      and(
        eq(copilots.scrapeProfileId, scrapeJobs.scrapeProfileId),
        eq(copilots.userId, scrapeJobs.userId),
      ),
    )
    .where(eq(scrapeJobs.status, "running"))
    .orderBy(desc(scrapeJobs.createdAt))
    .limit(1);

  if (!row) {
    return null;
  }

  const copilot = row.copilot;

  if (copilot.status === "running") {
    return copilot;
  }

  const subscription = await getActiveSubscription(copilot.userId);
  if (!subscription) {
    return null;
  }

  const progress = await getCopilotProgress(copilot, subscription);
  if (progress.dailyLimitReached) {
    return null;
  }

  return setCopilotRunning(copilot.id);
}

export async function resolveNextCopilot(): Promise<Copilot | null> {
  const synced = await syncCopilotsDailyStatus();
  if (synced) {
    return synced;
  }

  const pendingScrape = await resolveCopilotWithPendingScrapeJob();
  if (pendingScrape) {
    return pendingScrape;
  }

  return null;
}

export async function periodicCopilotNeedCheck(): Promise<Copilot | null> {
  return syncCopilotsDailyStatus();
}

export async function getRunningCopilots(): Promise<Copilot[]> {
  return db
    .select()
    .from(copilots)
    .where(eq(copilots.status, "running"))
    .orderBy(asc(copilots.updatedAt));
}

export async function getLastCopilotSendAt(
  copilotId: number,
): Promise<Date | null> {
  const [row] = await db
    .select({ sentAt: copilotLeadsTable.sentAt })
    .from(copilotLeadsTable)
    .where(
      and(
        eq(copilotLeadsTable.copilotId, copilotId),
        eq(copilotLeadsTable.status, "sent"),
      ),
    )
    .orderBy(desc(copilotLeadsTable.sentAt))
    .limit(1);

  return row?.sentAt ?? null;
}
