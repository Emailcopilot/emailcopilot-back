import { db } from "../db/drizzle";
import { usageTable } from "../db/schema";
import { eq, and, lte, gte, sql } from "drizzle-orm";

export async function incrementUsage(
    userId: number,
    subscriptionId: number,
    increments: { emailsSent?: number; copilotsCreated?: number; emailProfilesCreated?: number }
) {
    const now = new Date();

    await db
        .update(usageTable)
        .set({
            emailsSent: sql`${usageTable.emailsSent} + ${increments.emailsSent ?? 0}`,
            copilotsCreated: sql`${usageTable.copilotsCreated} + ${increments.copilotsCreated ?? 0}`,
            emailProfilesCreated: sql`${usageTable.emailProfilesCreated} + ${increments.emailProfilesCreated ?? 0}`,
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