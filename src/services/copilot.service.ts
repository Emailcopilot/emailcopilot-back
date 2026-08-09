import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import {
  copilotsTable,
  subscriptionsTable,
  scrapeProfilesTable,
  emailProfilesTable,
  emailTemplatesTable,
  scrapeJobsTable,
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

  if (!copilot.emailProfileId) {
    errors.push("email profile");
  }
  if (!copilot.scrapeProfileId) {
    errors.push("scrape profile");
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

  if (!copilot.emailProfileId) {
    throw Object.assign(new Error("Email profile is not properly configured"), {
      statusCode: 400,
    });
  }

  const [profile] = await db
    .select()
    .from(emailProfilesTable)
    .where(eq(emailProfilesTable.id, copilot.emailProfileId));

  if (!profile || !profile.smtpHost || !profile.email || !profile.smtpPass) {
    throw Object.assign(new Error("Email profile is not properly configured"), {
      statusCode: 400,
    });
  }
}

export async function listCopilots(req: Request, res: Response) {
  const userId = req.dbUser!.id;

  const rows = await db
    .select({
      ...getTableColumns(copilotsTable),
      scrapeProfile: getTableColumns(scrapeProfilesTable),
      emailProfile: getTableColumns(emailProfilesTable),
      template: getTableColumns(emailTemplatesTable),
    })
    .from(copilotsTable)
    .leftJoin(scrapeProfilesTable, eq(copilotsTable.scrapeProfileId, scrapeProfilesTable.id))
    .leftJoin(emailProfilesTable, eq(copilotsTable.emailProfileId, emailProfilesTable.id))
    .leftJoin(emailTemplatesTable, eq(copilotsTable.templateId, emailTemplatesTable.id))
    .orderBy(desc(copilotsTable.createdAt))
    .where(eq(copilotsTable.userId, userId));

  res.json(rows);
}

export async function getCopilot(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [row] = await db
    .select({
      ...getTableColumns(copilotsTable),
      scrapeProfile: getTableColumns(scrapeProfilesTable),
      emailProfile: getTableColumns(emailProfilesTable),
      template: getTableColumns(emailTemplatesTable),
    })
    .from(copilotsTable)
    .leftJoin(scrapeProfilesTable, eq(copilotsTable.scrapeProfileId, scrapeProfilesTable.id))
    .leftJoin(emailProfilesTable, eq(copilotsTable.emailProfileId, emailProfilesTable.id))
    .leftJoin(emailTemplatesTable, eq(copilotsTable.templateId, emailTemplatesTable.id))
    .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)));

  if (!row)
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });

  res.json(row);
}

export async function createCopilot(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const data = req.body as CreateCopilotInput;

  const sub = await getActiveSubscription(userId);
  await assertCopilotWithinPlanLimit(userId, sub.planId);

  const created = await db.transaction(async (tx) => {
    let scrapeProfileId = data.scrapeProfileId ?? null;
    const scrapeProfile = data.scrapeProfile ?? null;
    let scrapeProfileData = null;

    let emailProfileId = data.emailProfileId ?? null;
    const emailProfile = data.emailProfile ?? null;
    let emailProfileData = null;

    let templateId = data.templateId ?? null;
    const template = data.template ?? null;
    let templateData = null;

    if (!scrapeProfileId && scrapeProfile) {
      const [profile] = await tx
        .insert(scrapeProfilesTable)
        .values({ ...scrapeProfile, userId })
        .returning();
      scrapeProfileId = profile.id;
      scrapeProfileData = profile;
    }

    if (!emailProfileId && emailProfile) {
      const [profile] = await tx
        .insert(emailProfilesTable)
        .values({ ...emailProfile, userId })
        .returning();
      emailProfileId = profile.id;
      emailProfileData = profile;
    }

    if (!templateId && template) {
      const [createdTemplate] = await tx
        .insert(emailTemplatesTable)
        .values({ ...template, userId })
        .returning();
      templateId = createdTemplate.id;
      templateData = createdTemplate;
    }

    const [row] = await tx
      .insert(copilotsTable)
      .values({ ...data, userId, scrapeProfileId, emailProfileId, templateId })
      .returning();

    await incrementUsage(userId, sub.id, { copilotsCreated: 1 });

    if (scrapeProfileId && !scrapeProfileData) {
      const [profile] = await tx
        .select()
        .from(scrapeProfilesTable)
        .where(eq(scrapeProfilesTable.id, scrapeProfileId));

      scrapeProfileData = profile;
    }

    if (emailProfileId && !emailProfileData) {
      const [profile] = await tx
        .select()
        .from(emailProfilesTable)
        .where(eq(emailProfilesTable.id, emailProfileId));

      emailProfileData = profile;
    }

    if (templateId && !templateData) {
      const [createdTemplate] = await tx
        .select()
        .from(emailTemplatesTable)
        .where(eq(emailTemplatesTable.id, templateId));

      templateData = createdTemplate;
    }

    return {
      ...row,
      scrapeProfile: scrapeProfileData,
      emailProfile: emailProfileData,
      template: templateData,
    };
  });

  res.status(201).json(created);
}

export async function updateCopilot(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;
  const data = req.body as UpdateCopilotInput;

  let scrapeProfileId = data.scrapeProfileId ?? null;
  const scrapeProfile = data.scrapeProfile ?? null;

  let emailProfileId = data.emailProfileId ?? null;
  const emailProfile = data.emailProfile ?? null;

  let templateId = data.templateId ?? null;
  const template = data.template ?? null;

  const updated = await db.transaction(async (tx) => {
    let emailProfileData = null;
    let scrapeProfileData = null;
    let templateData = null;
    if (!scrapeProfileId && scrapeProfile) {
      const [profile] = await tx
        .insert(scrapeProfilesTable)
        .values({ ...scrapeProfile, userId })
        .returning();
      scrapeProfileId = profile.id;
      scrapeProfileData = profile;
    }

    if (!emailProfileId && emailProfile) {
      const [profile] = await tx
        .insert(emailProfilesTable)
        .values({ ...emailProfile, userId })
        .returning();
      emailProfileId = profile.id;
      emailProfileData = profile;
    }

    if (!templateId && template) {
      const [createdTemplate] = await tx
        .insert(emailTemplatesTable)
        .values({ ...template, userId })
        .returning();
      templateId = createdTemplate.id;
      templateData = createdTemplate;
    }

    const [row] = await tx
      .update(copilotsTable)
      .set({
        ...data,
        scrapeProfileId,
        emailProfileId,
        templateId,
        updatedAt: new Date(),
      })
      .where(and(eq(copilotsTable.id, id), eq(copilotsTable.userId, userId)))
      .returning();

    if (!row)
      throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });

    if (scrapeProfileId && !scrapeProfileData) {
      const [profile] = await tx
        .select()
        .from(scrapeProfilesTable)
        .where(eq(scrapeProfilesTable.id, scrapeProfileId));

      scrapeProfileData = profile;
    }

    if (emailProfileId && !emailProfileData) {
      const [profile] = await tx
        .select()
        .from(emailProfilesTable)
        .where(eq(emailProfilesTable.id, emailProfileId));

      emailProfileData = profile;
    }

    if (templateId && !templateData) {
      const [createdTemplate] = await tx
        .select()
        .from(emailTemplatesTable)
        .where(eq(emailTemplatesTable.id, templateId));

      templateData = createdTemplate;
    }

    return {
      ...row,
      scrapeProfile: scrapeProfileData,
      emailProfile: emailProfileData,
      template: templateData,
    };
  });

  res.json(updated);
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

  const [created] = await db
    .insert(copilotsTable)
    .values({
      userId,
      name: newName,
      description: original.description,
      status: "draft",
      sendLimit: original.sendLimit,
      sendLimitActive: original.sendLimitActive,
      activeDays: original.activeDays,
      sendingHours: original.sendingHours,
      sendingHoursActive: original.sendingHoursActive,
      timezone: original.timezone,
      emailProfileId: original.emailProfileId,
      scrapeProfileId: original.scrapeProfileId,
      templateId: original.templateId,
      emailsSent: 0,
      emailsOpened: 0,
      emailsReplied: 0,
    })
    .returning();

  await incrementUsage(userId, sub.id, { copilotsCreated: 1 });

  res.status(201).json(created);
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

  res.json(updated);
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

  const [newLeadsCount, sentToday] = await Promise.all([
    getCopilotNewLeadCount(id),
    getCopilotSentTodayCount(id, copilot.timezone),
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
