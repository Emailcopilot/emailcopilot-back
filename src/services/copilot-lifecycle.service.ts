import { db } from "../db/drizzle";
import {
  copilotsTable,
  copilotLeadsTable,
  scrapeJobsTable,
  subscriptionsTable,
  usageTable,
} from "../db/schema";
import type { Copilot } from "../db/schema";
import { and, asc, count, desc, eq, gte, lte, lt } from "drizzle-orm";
import { getPlan, isSubscriptionUsable } from "../lib/billing";
import {
  getCopilotDayBounds,
  isWithinSendWindow,
  OUTSIDE_SEND_WINDOW_MSG,
} from "../lib/send-window";

export type SubscriptionInfo = {
  subscriptionId: number;
  planId: string;
  maxEmailsPerMonth: number;
  totalEmailsSent: number;
  remainingEmails: number;
};

export type CopilotProgress = {
  sentTodayCount: number;
  newLeadCount: number;
  /** null = no daily cap; only subscription limit applies */
  dailySendLimit: number | null;
  remainingToday: number;
  dailyLimitReached: boolean;
  withinSendWindow: boolean;
  scrapeNeeded: number;
};

export async function getCopilotSentTodayCount(
  copilotId: number,
  timezone: string,
): Promise<number> {
  const { start, end } = getCopilotDayBounds(timezone);

  const [{ count: sentToday }] = await db
    .select({ count: count() })
    .from(copilotLeadsTable)
    .where(
      and(
        eq(copilotLeadsTable.copilotId, copilotId),
        eq(copilotLeadsTable.status, "sent"),
        gte(copilotLeadsTable.sentAt, start),
        lt(copilotLeadsTable.sentAt, end),
      ),
    );

  return sentToday;
}

export async function getActiveSubscription(
  userId: number,
): Promise<SubscriptionInfo | null> {
  const [subscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .orderBy(desc(subscriptionsTable.createdAt))
    .limit(1);

  if (!subscription || !isSubscriptionUsable(subscription)) {
    return null;
  }

  const plan = getPlan(subscription.planId);
  if (!plan) {
    return null;
  }

  const now = new Date();
  const [currentUsage] = await db
    .select()
    .from(usageTable)
    .where(
      and(
        eq(usageTable.userId, userId),
        eq(usageTable.subscriptionId, subscription.id),
        lte(usageTable.periodStart, now),
        gte(usageTable.periodEnd, now),
      ),
    )
    .limit(1);

  const totalEmailsSent = currentUsage?.emailsSent ?? 0;
  const remainingEmails = Math.max(0, plan.maxEmailsPerMonth - totalEmailsSent);

  return {
    subscriptionId: subscription.id,
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
  const sentTodayCount = await getCopilotSentTodayCount(
    copilot.id,
    copilot.timezone,
  );
  const newLeadCount = await getCopilotNewLeadCount(copilot.id);
  // Daily cap only when toggle is on and a positive limit is set
  const dailySendLimit =
    copilot.sendLimitActive && copilot.sendLimit != null
      ? copilot.sendLimit
      : null;
  const withinSendWindow = isWithinSendWindow(copilot);

  // null dailySendLimit = no daily cap; budget is subscription remaining only
  const remainingToday =
    dailySendLimit == null
      ? subscription.remainingEmails
      : Math.max(0, dailySendLimit - sentTodayCount);
  const dailyLimitReached = dailySendLimit != null && remainingToday <= 0;
  const scrapeBudget = Math.min(subscription.remainingEmails, remainingToday);
  const scrapeNeeded = withinSendWindow
    ? Math.max(0, scrapeBudget - newLeadCount)
    : 0;

  return {
    sentTodayCount,
    newLeadCount,
    dailySendLimit,
    remainingToday,
    dailyLimitReached,
    withinSendWindow,
    scrapeNeeded,
  };
}

const DAILY_LIMIT_MSG =
  "Daily send limit reached — will resume when quota resets";

export async function setCopilotActive(copilotId: number, reason?: string) {
  await db
    .update(copilotsTable)
    .set({
      status: "active",
      lastError: reason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(copilotsTable.id, copilotId));
  console.log(
    `🔄 Copilot ${copilotId} set to active${reason ? `: ${reason}` : ""}`,
  );
}

async function setCopilotRunning(copilotId: number): Promise<Copilot> {
  const [running] = await db
    .update(copilotsTable)
    .set({ status: "running", lastError: null, updatedAt: new Date() })
    .where(eq(copilotsTable.id, copilotId))
    .returning();

  console.log(`🚀 Copilot ${copilotId} set to running`);
  return running;
}

function canRunCopilot(
  subscription: SubscriptionInfo,
  progress: CopilotProgress,
): boolean {
  return (
    subscription.remainingEmails > 0 &&
    !progress.dailyLimitReached &&
    progress.remainingToday > 0 &&
    progress.withinSendWindow
  );
}

function inactiveReason(progress: CopilotProgress): string {
  if (!progress.withinSendWindow) {
    return OUTSIDE_SEND_WINDOW_MSG;
  }
  return DAILY_LIMIT_MSG;
}

/** Demote running copilots that cannot work; promote active with quota + window → running. */
export async function syncCopilotsDailyStatus(): Promise<Copilot | null> {
  const runningCopilots = await getRunningCopilots();

  for (const copilot of runningCopilots) {
    const subscription = await getActiveSubscription(copilot.userId);
    if (!subscription) {
      continue;
    }

    const progress = await getCopilotProgress(copilot, subscription);

    if (!canRunCopilot(subscription, progress)) {
      await setCopilotActive(copilot.id, inactiveReason(progress));
    }
  }

  const activeCopilots = await db
    .select()
    .from(copilotsTable)
    .where(eq(copilotsTable.status, "active"))
    .orderBy(asc(copilotsTable.updatedAt));

  for (const copilot of activeCopilots) {
    const subscription = await getActiveSubscription(copilot.userId);
    if (!subscription) {
      continue;
    }

    const progress = await getCopilotProgress(copilot, subscription);

    if (canRunCopilot(subscription, progress)) {
      return setCopilotRunning(copilot.id);
    }
  }

  const stillRunning = await getRunningCopilots();

  for (const copilot of stillRunning) {
    const subscription = await getActiveSubscription(copilot.userId);
    if (!subscription) {
      continue;
    }

    const progress = await getCopilotProgress(copilot, subscription);

    if (canRunCopilot(subscription, progress)) {
      return copilot;
    }
  }

  return null;
}

export async function pauseCopilot(copilotId: number, reason: string) {
  await db
    .update(copilotsTable)
    .set({
      status: "paused",
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(eq(copilotsTable.id, copilotId));
  console.log(`⏸️  Copilot ${copilotId} paused: ${reason}`);
}

export async function completeCopilot(copilotId: number) {
  await db
    .update(copilotsTable)
    .set({
      status: "completed",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(copilotsTable.id, copilotId));
  console.log(`✅ Copilot ${copilotId} completed`);
}

async function resolveCopilotWithPendingScrapeJob(): Promise<Copilot | null> {
  const [row] = await db
    .select({ copilot: copilotsTable })
    .from(scrapeJobsTable)
    .innerJoin(
      copilotsTable,
      and(
        eq(copilotsTable.targetAudienceId, scrapeJobsTable.targetAudienceId),
        eq(copilotsTable.userId, scrapeJobsTable.userId),
      ),
    )
    .where(eq(scrapeJobsTable.status, "running"))
    .orderBy(desc(scrapeJobsTable.createdAt))
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
  if (!canRunCopilot(subscription, progress)) {
    return null;
  }

  return setCopilotRunning(copilot.id);
}

export async function resolveNextCopilot(): Promise<Copilot | null> {
  const synced = await syncCopilotsDailyStatus();
  if (synced) {
    return synced;
  }

  return resolveCopilotWithPendingScrapeJob();
}

export async function getRunningCopilots(): Promise<Copilot[]> {
  return db
    .select()
    .from(copilotsTable)
    .where(eq(copilotsTable.status, "running"))
    .orderBy(asc(copilotsTable.updatedAt));
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
