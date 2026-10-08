import { db } from "../db/drizzle";
import { subscriptionsTable, usageTable } from "../db/schema";
import { eq, and, lte, gte, sql, asc, desc, inArray } from "drizzle-orm";
import { isSubscriptionUsable, monthlyUsageWindow } from "./billing";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The usage row that covers `now`. When webhook retries inserted overlaps,
 * keep the row with the real counters and delete the rest.
 */
async function collapseCoveringUsage(
    tx: Tx,
    userId: number,
    subscriptionId: number,
    now: Date,
) {
    const rows = await tx
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
        .orderBy(desc(usageTable.emailsSent), asc(usageTable.periodStart), asc(usageTable.id))
        .for("update");

    const [keeper, ...extras] = rows;
    if (!keeper) return null;

    if (extras.length > 0) {
        await tx.delete(usageTable).where(
            inArray(
                usageTable.id,
                extras.map((row) => row.id),
            ),
        );
        console.log(
            `🧹 Removed ${extras.length} overlapping usage row(s) for user ${userId}: ${extras.map((row) => row.id).join(", ")}`,
        );
    }

    return keeper;
}

/** Open the monthly usage row that covers today when the subscription is still active. */
export async function ensureCurrentUsagePeriod(userId: number, subscriptionId: number) {
    return db.transaction(async (tx) => {
        const [sub] = await tx
            .select()
            .from(subscriptionsTable)
            .where(eq(subscriptionsTable.id, subscriptionId))
            .limit(1)
            .for("update");

        if (!sub || sub.userId !== userId || !isSubscriptionUsable(sub)) {
            return null;
        }

        const now = new Date();
        const current = await collapseCoveringUsage(tx, userId, subscriptionId, now);
        if (current) return current;

        const anchor = sub.currentPeriodStart ?? now;
        const { periodStart, periodEnd } = monthlyUsageWindow(anchor, now);

        const [created] = await tx
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
    });
}

/** Reuse the open monthly window. A paid webhook must not start a second one. */
export async function reuseOrCreateUsagePeriod(
    tx: Tx,
    userId: number,
    subscriptionId: number,
    periodStart: Date,
    periodEnd: Date,
) {
    const existing = await collapseCoveringUsage(tx, userId, subscriptionId, periodStart);
    if (existing) return existing;

    const [created] = await tx
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

    console.log(
        `✅ Created usage record for user ${userId}, period ${periodStart.toISOString()}`,
    );
    return created;
}

export async function incrementUsage(
    userId: number,
    subscriptionId: number,
    increments: { emailsSent?: number; copilotsCreated?: number; emailAccountsCreated?: number }
) {
    const current = await ensureCurrentUsagePeriod(userId, subscriptionId);
    if (!current) return;

    await db
        .update(usageTable)
        .set({
            emailsSent: sql`${usageTable.emailsSent} + ${increments.emailsSent ?? 0}`,
            copilotsCreated: sql`${usageTable.copilotsCreated} + ${increments.copilotsCreated ?? 0}`,
            emailAccountsCreated: sql`${usageTable.emailAccountsCreated} + ${increments.emailAccountsCreated ?? 0}`,
            updatedAt: new Date(),
        })
        .where(eq(usageTable.id, current.id));
}
