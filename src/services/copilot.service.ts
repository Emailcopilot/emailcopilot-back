import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import {
  copilots,
  subscriptions,
  scrapeProfiles,
  emailProfiles,
  scrapeJobs,
  emailLogs,
} from "../db/schema";
import { and, desc, eq, gte, count, getTableColumns, ne } from "drizzle-orm";
import { incrementUsage } from "../lib/helpers";
import { getPlanLimits, isSubscriptionUsable } from "../lib/billing";
import { getCopilotNewLeadCount } from "./copilot-lifecycle.service";
import type {
  CreateCopilotInput,
  UpdateCopilotInput,
  UpdateCopilotStatusInput,
} from "../validators/copilot.validator";

async function getActiveSubscription(userId: number) {
  const subs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt));
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
    .from(copilots)
    .where(and(eq(copilots.userId, userId), ne(copilots.status, "archived")));

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
    .from(copilots)
    .where(eq(copilots.id, copilotId));

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
    .from(emailProfiles)
    .where(eq(emailProfiles.id, copilot.emailProfileId));

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
      ...getTableColumns(copilots),
      scrapeProfile: getTableColumns(scrapeProfiles),
      emailProfile: getTableColumns(emailProfiles),
    })
    .from(copilots)
    .leftJoin(scrapeProfiles, eq(copilots.scrapeProfileId, scrapeProfiles.id))
    .leftJoin(emailProfiles, eq(copilots.emailProfileId, emailProfiles.id))
    .orderBy(desc(copilots.createdAt))
    .where(eq(copilots.userId, userId));

  res.json(rows);
}

export async function getCopilot(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [row] = await db
    .select({
      ...getTableColumns(copilots),
      scrapeProfile: getTableColumns(scrapeProfiles),
      emailProfile: getTableColumns(emailProfiles),
    })
    .from(copilots)
    .leftJoin(scrapeProfiles, eq(copilots.scrapeProfileId, scrapeProfiles.id))
    .leftJoin(emailProfiles, eq(copilots.emailProfileId, emailProfiles.id))
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)));

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

    if (!scrapeProfileId && scrapeProfile) {
      const [profile] = await tx
        .insert(scrapeProfiles)
        .values({ ...scrapeProfile, userId })
        .returning();
      scrapeProfileId = profile.id;
      scrapeProfileData = profile;
    }

    if (!emailProfileId && emailProfile) {
      const [profile] = await tx
        .insert(emailProfiles)
        .values({ ...emailProfile, userId })
        .returning();
      emailProfileId = profile.id;
      emailProfileData = profile;
    }

    const [row] = await tx
      .insert(copilots)
      .values({ ...data, userId, scrapeProfileId, emailProfileId })
      .returning();

    await incrementUsage(userId, sub.id, { copilotsCreated: 1 });

    if (scrapeProfileId && !scrapeProfileData) {
      const [profile] = await tx
        .select()
        .from(scrapeProfiles)
        .where(eq(scrapeProfiles.id, scrapeProfileId));

      scrapeProfileData = profile;
    }

    if (emailProfileId && !emailProfileData) {
      const [profile] = await tx
        .select()
        .from(emailProfiles)
        .where(eq(emailProfiles.id, emailProfileId));

      emailProfileData = profile;
    }

    return {
      ...row,
      scrapeProfile: scrapeProfileData,
      emailProfile: emailProfileData,
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

  const updated = await db.transaction(async (tx) => {
    let emailProfileData = null;
    let scrapeProfileData = null;
    if (!scrapeProfileId && scrapeProfile) {
      const [profile] = await tx
        .insert(scrapeProfiles)
        .values({ ...scrapeProfile, userId })
        .returning();
      scrapeProfileId = profile.id;
      scrapeProfileData = profile;
    }

    if (!emailProfileId && emailProfile) {
      const [profile] = await tx
        .insert(emailProfiles)
        .values({ ...emailProfile, userId })
        .returning();
      emailProfileId = profile.id;
      emailProfileData = profile;
    }

    const [row] = await tx
      .update(copilots)
      .set({ ...data, scrapeProfileId, emailProfileId, updatedAt: new Date() })
      .where(and(eq(copilots.id, id), eq(copilots.userId, userId)))
      .returning();

    if (!row)
      throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });

    if (scrapeProfileId && !scrapeProfileData) {
      const [profile] = await tx
        .select()
        .from(scrapeProfiles)
        .where(eq(scrapeProfiles.id, scrapeProfileId));

      scrapeProfileData = profile;
    }

    if (emailProfileId && !emailProfileData) {
      const [profile] = await tx
        .select()
        .from(emailProfiles)
        .where(eq(emailProfiles.id, emailProfileId));

      emailProfileData = profile;
    }

    return {
      ...row,
      scrapeProfile: scrapeProfileData,
      emailProfile: emailProfileData,
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
    .delete(copilots)
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)));

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
    .from(copilots)
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)));

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
    .insert(copilots)
    .values({
      userId,
      name: newName,
      description: original.description,
      status: "draft",
      emailProfileId: original.emailProfileId,
      scrapeProfileId: original.scrapeProfileId,
      templateId: original.templateId,
      settings: original.settings,
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
    .update(copilots)
    .set({ status: data.status, updatedAt: new Date() })
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)))
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
    .from(copilots)
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)));

  if (!copilot) {
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  }

  await validateCopilotCanActivate(id);

  console.log(
    ` ${new Date().toLocaleTimeString()} - 🚀 Activating copilot ${id} for scraping loop (user ${userId})`,
  );

  const [updated] = await db
    .update(copilots)
    .set({
      status: "active",
      lastRunAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)))
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
    .from(copilots)
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)));

  if (!copilot) {
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  }

  let scrapeJob = null;
  if (copilot.lastJobId) {
    scrapeJob = await db.query.scrapeJobs.findFirst({
      where: eq(scrapeJobs.id, copilot.lastJobId),
    });
  }

  let emailStats = null;
  if (copilot.lastRunAt) {
    const startOfDay = new Date(copilot.lastRunAt);
    startOfDay.setHours(0, 0, 0, 0);

    const [stats] = await db
      .select({
        sent: count(),
      })
      .from(emailLogs)
      .where(
        and(
          eq(emailLogs.usersId, userId),
          eq(emailLogs.status, "sent"),
          gte(emailLogs.sentAt, startOfDay),
        ),
      );

    emailStats = {
      sentToday: Number(stats?.sent ?? 0),
    };
  }

  const newLeadsCount = await getCopilotNewLeadCount(id);

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
