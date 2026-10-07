import { db } from "../db/drizzle";
import { subscriptionsTable, usageTable } from "../db/schema";
import { eq, and, lte, gte, sql } from "drizzle-orm";
import { isSubscriptionUsable, monthlyUsageWindow } from "./billing";

/** Open the monthly usage row that covers today when the subscription is still active. */
export async function ensureCurrentUsagePeriod(userId: number, subscriptionId: number) {
    const [sub] = await db
        .select()
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.id, subscriptionId))
        .limit(1);

    if (!sub || sub.userId !== userId || !isSubscriptionUsable(sub)) {
        return null;
    }

    const now = new Date();
    const [current] = await db
        .select()
        .from(usageTable)
        .where(
            and(
                eq(usageTable.userId, userId),
                eq(usageTable.subscriptionId, subscriptionId),
                lte(usageTable.periodStart, now),
                gte(usageTable.periodEnd, now),
            ),
        )
        .limit(1);

    if (current) return current;

    const anchor = sub.currentPeriodStart ?? now;
    const { periodStart, periodEnd } = monthlyUsageWindow(anchor, now);

    const [existing] = await db
        .select()
        .from(usageTable)
        .where(
            and(
                eq(usageTable.userId, userId),
                eq(usageTable.subscriptionId, subscriptionId),
                eq(usageTable.periodStart, periodStart),
            ),
        )
        .limit(1);

    if (existing) return existing;

    const [created] = await db
        .insert(usageTable)
        .values({
            userId,
            subscriptionId,
            periodStart,
            periodEnd,
            emailsSent: 0,
            copilotsCreated: 0,
            emailAccountsCreated: 0,
        })
        .returning();

    return created;
}

export async function incrementUsage(
    userId: number,
    subscriptionId: number,
    increments: { emailsSent?: number; copilotsCreated?: number; emailAccountsCreated?: number }
) {
    await ensureCurrentUsagePeriod(userId, subscriptionId);

    const now = new Date();

    await db
        .update(usageTable)
        .set({
            emailsSent: sql`${usageTable.emailsSent} + ${increments.emailsSent ?? 0}`,
            copilotsCreated: sql`${usageTable.copilotsCreated} + ${increments.copilotsCreated ?? 0}`,
            emailAccountsCreated: sql`${usageTable.emailAccountsCreated} + ${increments.emailAccountsCreated ?? 0}`,
            updatedAt: now,
        })
        .where(
            and(
                eq(usageTable.userId, userId),
                eq(usageTable.subscriptionId, subscriptionId),
                lte(usageTable.periodStart, now),
                gte(usageTable.periodEnd, now)
            )
        );
}