import type { Request, Response } from "express";
import { and, count, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../db/drizzle";
import { copilotsTable, sentEmailsTable } from "../db/schema";
import type { DashboardAnalyticsInput } from "../validators/analytics.validator";

const PERIOD_DAYS: Record<DashboardAnalyticsInput["period"], number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDayLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function percentChange(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 100);
}

function resolveRanges(period: DashboardAnalyticsInput["period"]) {
  const days = PERIOD_DAYS[period];
  const end = addUtcDays(startOfUtcDay(new Date()), 1); // tomorrow 00:00 UTC
  const currentStart = addUtcDays(end, -days);
  const previousStart = addUtcDays(currentStart, -days);

  return { days, end, currentStart, previousStart };
}

function emptyDailySeries(start: Date, days: number) {
  return Array.from({ length: days }, (_, i) => {
    const date = toDateKey(addUtcDays(start, i));
    return { date, emailsSent: 0, replies: 0 };
  });
}

export async function getDashboardAnalytics(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const { period } = req.query as unknown as DashboardAnalyticsInput;
  const { days, end, currentStart, previousStart } = resolveRanges(period);

  const dayExpr = sql<string>`to_char(date_trunc('day', ${sentEmailsTable.sentAt}), 'YYYY-MM-DD')`;
  const replyDayExpr = sql<string>`to_char(date_trunc('day', ${sentEmailsTable.repliedAt}), 'YYYY-MM-DD')`;

  const userScope = eq(copilotsTable.userId, userId);

  const [sentRows, replyRows, [{ copilotsCount }]] = await Promise.all([
    db
      .select({
        day: dayExpr,
        count: count(),
      })
      .from(sentEmailsTable)
      .innerJoin(copilotsTable, eq(sentEmailsTable.copilotId, copilotsTable.id))
      .where(
        and(
          userScope,
          isNotNull(sentEmailsTable.sentAt),
          gte(sentEmailsTable.sentAt, previousStart),
          lt(sentEmailsTable.sentAt, end),
        ),
      )
      .groupBy(dayExpr),
    db
      .select({
        day: replyDayExpr,
        count: count(),
      })
      .from(sentEmailsTable)
      .innerJoin(copilotsTable, eq(sentEmailsTable.copilotId, copilotsTable.id))
      .where(
        and(
          userScope,
          isNotNull(sentEmailsTable.repliedAt),
          gte(sentEmailsTable.repliedAt, previousStart),
          lt(sentEmailsTable.repliedAt, end),
        ),
      )
      .groupBy(replyDayExpr),
    db
      .select({ copilotsCount: count() })
      .from(copilotsTable)
      .where(and(eq(copilotsTable.userId, userId), ne(copilotsTable.status, "archived"))),
  ]);

  const currentStartKey = toDateKey(currentStart);
  const previousStartKey = toDateKey(previousStart);
  const currentEndKey = toDateKey(addUtcDays(end, -1));
  const previousEndKey = toDateKey(addUtcDays(currentStart, -1));

  const daily = emptyDailySeries(currentStart, days);

  let currentEmailsSent = 0;
  let previousEmailsSent = 0;
  let currentReplies = 0;
  let previousReplies = 0;

  for (const row of sentRows) {
    const n = Number(row.count);
    if (row.day >= currentStartKey) {
      currentEmailsSent += n;
      const point = daily.find((d) => d.date === row.day);
      if (point) point.emailsSent = n;
    } else if (row.day >= previousStartKey) {
      previousEmailsSent += n;
    }
  }

  for (const row of replyRows) {
    const n = Number(row.count);
    if (row.day >= currentStartKey) {
      currentReplies += n;
      const point = daily.find((d) => d.date === row.day);
      if (point) point.replies = n;
    } else if (row.day >= previousStartKey) {
      previousReplies += n;
    }
  }

  const currentReplyRate =
    currentEmailsSent === 0 ? 0 : (currentReplies / currentEmailsSent) * 100;
  const previousReplyRate =
    previousEmailsSent === 0 ? 0 : (previousReplies / previousEmailsSent) * 100;

  res.json({
    period,
    current: {
      from: currentStartKey,
      to: currentEndKey,
    },
    previous: {
      from: previousStartKey,
      to: previousEndKey,
      label: `${formatDayLabel(previousStartKey)} - ${formatDayLabel(previousEndKey)}`,
    },
    summary: {
      emailsSent: {
        value: currentEmailsSent,
        changePercent: percentChange(currentEmailsSent, previousEmailsSent),
      },
      replies: {
        value: currentReplies,
        changePercent: percentChange(currentReplies, previousReplies),
      },
      replyRate: {
        value: Math.round(currentReplyRate * 10) / 10,
        changePercent: percentChange(currentReplyRate, previousReplyRate),
      },
      copilots: {
        value: copilotsCount,
      },
    },
    daily,
  });
}
