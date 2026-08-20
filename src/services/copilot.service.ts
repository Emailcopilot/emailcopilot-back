import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import {
  copilotsTable,
  subscriptionsTable,
  targetAudienceTable,
  emailAccountTable,
  emailTemplatesTable,
  scrapeJobsTable,
  flightScheduleTable,
} from "../db/schema";
import { and, count, desc, eq, getTableColumns, ne } from "drizzle-orm";
import { incrementUsage } from "../lib/helpers";
import { getPlanLimits, isSubscriptionUsable } from "../lib/billing";
import {
  getCopilotNewLeadCount,
  getCopilotSentTodayCount,
} from "./copilot-lifecycle.service";
import type {
  CreateCopilotInput,
  UpdateCopilotInput,
  UpdateCopilotStatusInput,
} from "../validators/copilot.validator";
import {
  normalizeCopilotInput,
  withLegacyCopilotKeys,
} from "../lib/api-aliases";

async function getActiveSubscription(userId: number) {
  const subs = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .orderBy(desc(subscriptionsTable.createdAt));
  const sub = subs[0];
  if (!sub || !isSubscriptionUsable(sub))
    throw Object.assign(new Error("No active subscription found"), {
      statusCode: 403,
    });
  return sub;
}

async function assertCopilotWithinPlanLimit(userId: number, planId: string) {
  const limits = getPlanLimits(planId);
  if (!limits || limits.copilots === null) return;

  const [{ copilotsCount }] = await db
    .select({ copilotsCount: count() })
    .from(copilotsTable)
    .where(and(eq(copilotsTable.userId, userId), ne(copilotsTable.status, "archived")));

  if (copilotsCount >= limits.copilots) {
    throw Object.assign(
      new Error(
        `Plan limit reached: max ${limits.copilots} copilots on ${planId}`,
      ),
      { statusCode: 403 },
    );
  }
}

async function validateCopilotCanActivate(copilotId: number) {
  const [copilot] = await db
    .select()
    .from(copilotsTable)
    .where(eq(copilotsTable.id, copilotId));

  if (!copilot) {
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  }

  const errors: string[] = [];

  if (!copilot.emailAccountId) {
    errors.push("email account");
  }
  if (!copilot.targetAudienceId) {
    errors.push("target audience");
  }
  if (!copilot.templateId) {
    errors.push("template");
  }

  if (errors.length > 0) {
    throw Object.assign(
      new Error(`Cannot activate copilot. Missing: ${errors.join(", ")}`),
      { statusCode: 400 },
    );
  }

  if (!copilot.emailAccountId) {
    throw Object.assign(new Error("Email account is not properly configured"), {
      statusCode: 400,
    });
  }

  const [profile] = await db
    .select()
    .from(emailAccountTable)
    .where(eq(emailAccountTable.id, copilot.emailAccountId));

  if (!profile || !profile.smtpHost || !profile.email || !profile.smtpPass) {
    throw Object.assign(new Error("Email account is not properly configured"), {
      statusCode: 400,
    });
  }
}

export async function listCopilots(req: Request, res: Response) {
  const userId = req.dbUser!.id;

  const rows = await db
    .select({
      ...getTableColumns(copilotsTable),
      targetAudience: getTableColumns(targetAudienceTable),
      emailAccount: getTableColumns(emailAccountTable),
      template: getTableColumns(emailTemplatesTable),
      flightSchedule: getTableColumns(flightScheduleTable),
    })
    .from(copilotsTable)
    .leftJoin(targetAudienceTable, eq(copilotsTable.targetAudienceId, targetAudienceTable.id))
    .leftJoin(emailAccountTable, eq(copilotsTable.emailAccountId, emailAccountTable.id))
    .leftJoin(emailTemplatesTable, eq(copilotsTable.templateId, emailTemplatesTable.id))
    .leftJoin(flightScheduleTable, eq(copilotsTable.flightScheduleId, flightScheduleTable.id))
    .orderBy(desc(copilotsTable.createdAt))
    .where(eq(copilotsTable.userId, userId));

  res.json(rows.map(withLegacyCopilotKeys));
}

export async function getCopilot(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [row] = await db
    .select({
      ...getTableColumns(copilotsTable),
      targetAudience: getTableColumns(targetAudienceTable),
      emailAccount: getTableColumns(emailAccountTable),
      template: getTableColumns(emailTemplatesTable),
      flightSchedule: getTableColumns(flightScheduleTable),
    })
    .from(copilotsTable)
    .leftJoin(targetAudienceTable, eq(copilotsTable.targetAudienceId, targetAudienceTable.id))
    .leftJoin(emailAccountTable, eq(copilotsTable.emailAccountId, emailAccountTable.id))
    .leftJoin(emailTemplatesTable, eq(copilotsTable.templateId, emailTemplatesTable.id))
    .leftJoin(flightScheduleTable, eq(copilotsTable.flightScheduleId, flightScheduleTable.id))
    .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)));

  if (!row)
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });

  res.json(withLegacyCopilotKeys(row));
}

export async function createCopilot(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const data = normalizeCopilotInput(req.body as CreateCopilotInput);

  const sub = await getActiveSubscription(userId);
  await assertCopilotWithinPlanLimit(userId, sub.planId);

  const created = await db.transaction(async (tx) => {
    let targetAudienceId = data.targetAudienceId ?? null;
    const targetAudience = data.targetAudience ?? null;
    let targetAudienceData = null;

    let emailAccountId = data.emailAccountId ?? null;
    const emailAccount = data.emailAccount ?? null;
    let emailAccountData = null;

    let templateId = data.templateId ?? null;
    const template = data.template ?? null;
    let templateData = null;

    let flightScheduleId = data.flightScheduleId ?? null;
    const flightSchedule = data.flightSchedule ?? null;
    let flightScheduleData = null;

    if (!targetAudienceId && targetAudience) {
      const [profile] = await tx
        .insert(targetAudienceTable)
        .values({ ...targetAudience, userId })
        .returning();
      targetAudienceId = profile.id;
      targetAudienceData = profile;
    }

    if (!emailAccountId && emailAccount) {
      const [profile] = await tx
        .insert(emailAccountTable)
        .values({ ...emailAccount, userId })
        .returning();
      emailAccountId = profile.id;
      emailAccountData = profile;
    }

    if (!templateId && template) {
      const [createdTemplate] = await tx
        .insert(emailTemplatesTable)
        .values({ ...template, userId })
        .returning();
      templateId = createdTemplate.id;
      templateData = createdTemplate;
    }

    if (!flightScheduleId) {
      const [schedule] = await tx
        .insert(flightScheduleTable)
        .values({ ...(flightSchedule ?? {}), userId })
        .returning();
      flightScheduleId = schedule.id;
      flightScheduleData = schedule;
    }

    const [row] = await tx
      .insert(copilotsTable)
      .values({
        name: data.name,
        description: data.description,
        userId,
        targetAudienceId,
        emailAccountId,
        templateId,
        flightScheduleId,
      })
      .returning();

    await incrementUsage(userId, sub.id, { copilotsCreated: 1 });

    if (targetAudienceId && !targetAudienceData) {
      const [profile] = await tx
        .select()
        .from(targetAudienceTable)
        .where(eq(targetAudienceTable.id, targetAudienceId));

      targetAudienceData = profile;
    }

    if (emailAccountId && !emailAccountData) {
      const [profile] = await tx
        .select()
        .from(emailAccountTable)
        .where(eq(emailAccountTable.id, emailAccountId));

      emailAccountData = profile;
    }

    if (templateId && !templateData) {
      const [createdTemplate] = await tx
        .select()
        .from(emailTemplatesTable)
        .where(eq(emailTemplatesTable.id, templateId));

      templateData = createdTemplate;
    }

    if (flightScheduleId && !flightScheduleData) {
      const [schedule] = await tx
        .select()
        .from(flightScheduleTable)
        .where(eq(flightScheduleTable.id, flightScheduleId));

      flightScheduleData = schedule;
    }

    return {
      ...row,
      targetAudience: targetAudienceData,
      emailAccount: emailAccountData,
      template: templateData,
      flightSchedule: flightScheduleData,
    };
  });

  res.status(201).json(withLegacyCopilotKeys(created));
}

export async function updateCopilot(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;
  const data = normalizeCopilotInput(req.body as UpdateCopilotInput);
  const {
    targetAudience: nestedTargetAudience,
    emailAccount: nestedEmailAccount,
    template: nestedTemplate,
    flightSchedule: nestedFlightSchedule,
    ...copilotFields
  } = data;

  let targetAudienceId = data.targetAudienceId ?? null;
  const targetAudience = nestedTargetAudience ?? null;

  let emailAccountId = data.emailAccountId ?? null;
  const emailAccount = nestedEmailAccount ?? null;

  let templateId = data.templateId ?? null;
  const template = nestedTemplate ?? null;

  let flightScheduleId: number | null | undefined = data.flightScheduleId;
  const flightSchedule = nestedFlightSchedule ?? null;

  const updated = await db.transaction(async (tx) => {
    let emailAccountData = null;
    let targetAudienceData = null;
    let templateData = null;
    let flightScheduleData = null;
    if (!targetAudienceId && targetAudience) {
      const [profile] = await tx
        .insert(targetAudienceTable)
        .values({ ...targetAudience, userId })
        .returning();
      targetAudienceId = profile.id;
      targetAudienceData = profile;
    }

    if (!emailAccountId && emailAccount) {
      const [profile] = await tx
        .insert(emailAccountTable)
        .values({ ...emailAccount, userId })
        .returning();
      emailAccountId = profile.id;
      emailAccountData = profile;
    }

    if (!templateId && template) {
      const [createdTemplate] = await tx
        .insert(emailTemplatesTable)
        .values({ ...template, userId })
        .returning();
      templateId = createdTemplate.id;
      templateData = createdTemplate;
    }

    const [existing] = await tx
      .select()
      .from(copilotsTable)
      .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)));

    if (!existing)
      throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });

    flightScheduleId = flightScheduleId ?? existing.flightScheduleId ?? null;

    if (flightSchedule) {
      if (flightScheduleId) {
        const [schedule] = await tx
          .update(flightScheduleTable)
          .set({ ...flightSchedule, updatedAt: new Date() })
          .where(eq(flightScheduleTable.id, flightScheduleId))
          .returning();
        flightScheduleData = schedule;
      } else {
        const [schedule] = await tx
          .insert(flightScheduleTable)
          .values({ ...flightSchedule, userId })
          .returning();
        flightScheduleId = schedule.id;
        flightScheduleData = schedule;
      }
    }

    const [row] = await tx
      .update(copilotsTable)
      .set({
        ...copilotFields,
        targetAudienceId,
        emailAccountId,
        templateId,
        flightScheduleId,
        updatedAt: new Date(),
      })
      .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)))
      .returning();

    if (!row)
      throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });

    if (targetAudienceId && !targetAudienceData) {
      const [profile] = await tx
        .select()
        .from(targetAudienceTable)
        .where(eq(targetAudienceTable.id, targetAudienceId));

      targetAudienceData = profile;
    }

    if (emailAccountId && !emailAccountData) {
      const [profile] = await tx
        .select()
        .from(emailAccountTable)
        .where(eq(emailAccountTable.id, emailAccountId));

      emailAccountData = profile;
    }

    if (templateId && !templateData) {
      const [createdTemplate] = await tx
        .select()
        .from(emailTemplatesTable)
        .where(eq(emailTemplatesTable.id, templateId));

      templateData = createdTemplate;
    }

    if (flightScheduleId && !flightScheduleData) {
      const [schedule] = await tx
        .select()
        .from(flightScheduleTable)
        .where(eq(flightScheduleTable.id, flightScheduleId));

      flightScheduleData = schedule;
    }

    return {
      ...row,
      targetAudience: targetAudienceData,
      emailAccount: emailAccountData,
      template: templateData,
      flightSchedule: flightScheduleData,
    };
  });

  res.json(withLegacyCopilotKeys(updated));
}

export async function deleteCopilot(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  await db
    .delete(copilotsTable)
    .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)));

  res.status(204).send();
}

export async function duplicateCopilot(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [original] = await db
    .select()
    .from(copilotsTable)
    .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)));

  if (!original) {
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  }

  const sub = await getActiveSubscription(userId);
  await assertCopilotWithinPlanLimit(userId, sub.planId);

  const newName =
    original.name.length > 140
      ? "Copy of " + original.name.substring(0, 140)
      : "Copy of " + original.name;

  let flightScheduleId: number | null = null;
  if (original.flightScheduleId) {
    const [originalSchedule] = await db
      .select()
      .from(flightScheduleTable)
      .where(eq(flightScheduleTable.id, original.flightScheduleId));

    if (originalSchedule) {
      const [copied] = await db
        .insert(flightScheduleTable)
        .values({
          userId,
          name: originalSchedule.name,
          sendLimit: originalSchedule.sendLimit,
          sendLimitActive: originalSchedule.sendLimitActive,
          activeDays: originalSchedule.activeDays,
          sendingHours: originalSchedule.sendingHours,
          sendingHoursActive: originalSchedule.sendingHoursActive,
          timezone: originalSchedule.timezone,
        })
        .returning();
      flightScheduleId = copied.id;
    }
  }

  const [created] = await db
    .insert(copilotsTable)
    .values({
      userId,
      name: newName,
      description: original.description,
      status: "draft",
      flightScheduleId,
      emailAccountId: original.emailAccountId,
      targetAudienceId: original.targetAudienceId,
      templateId: original.templateId,
      emailsSent: 0,
      emailsOpened: 0,
      emailsReplied: 0,
    })
    .returning();

  await incrementUsage(userId, sub.id, { copilotsCreated: 1 });

  res.status(201).json(withLegacyCopilotKeys(created));
}

export async function updateCopilotStatus(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;
  const data = req.body as UpdateCopilotStatusInput;

  const [updated] = await db
    .update(copilotsTable)
    .set({ status: data.status, updatedAt: new Date() })
    .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)))
    .returning();

  if (!updated)
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });

  if (data.status === "active") {
    await validateCopilotCanActivate(id);
  }

  res.json(withLegacyCopilotKeys(updated));
}

export async function runCopilot(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [copilot] = await db
    .select()
    .from(copilotsTable)
    .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)));

  if (!copilot) {
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  }

  await validateCopilotCanActivate(id);

  console.log(
    ` ${new Date().toLocaleTimeString()} - 🚀 Activating copilot ${id} for scraping loop (user ${userId})`,
  );

  const [updated] = await db
    .update(copilotsTable)
    .set({
      status: "active",
      lastRunAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)))
    .returning();

  res.json({
    message: "Copilot activated; scraping loop will pick it up",
    copilotId: id,
    status: updated.status,
  });
}

export async function getCopilotStatus(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [copilot] = await db
    .select()
    .from(copilotsTable)
    .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)));

  if (!copilot) {
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  }

  let scrapeJob = null;
  if (copilot.lastJobId) {
    scrapeJob = await db.query.scrapeJobsTable.findFirst({
      where: eq(scrapeJobsTable.id, copilot.lastJobId),
    });
  }

  const [schedule] = copilot.flightScheduleId
    ? await db
        .select()
        .from(flightScheduleTable)
        .where(eq(flightScheduleTable.id, copilot.flightScheduleId))
    : [];

  const [newLeadsCount, sentToday] = await Promise.all([
    getCopilotNewLeadCount(id),
    getCopilotSentTodayCount(id, schedule?.timezone ?? "UTC"),
  ]);

  const emailStats = { sentToday };

  res.json({
    id: copilot.id,
    name: copilot.name,
    status: copilot.status,
    lastRunAt: copilot.lastRunAt,
    lastError: copilot.lastError,
    emailsSent: copilot.emailsSent,
    emailsOpened: copilot.emailsOpened,
    emailsReplied: copilot.emailsReplied,
    newLeadsCount,
    scrapeJob: scrapeJob
      ? {
          id: scrapeJob.id,
          status: scrapeJob.status,
          leadsFound: scrapeJob.leadsFound,
          errorMessage: scrapeJob.errorMessage,
          createdAt: scrapeJob.createdAt,
          finishedAt: scrapeJob.finishedAt,
        }
      : null,
    emailStats,
  });
}
