import { db } from "../db/drizzle";
import { copilots, subscriptions, scrapeProfiles, emailProfiles, emailTemplates, scrapeJobs, emailLogs, leads } from "../db/schema";
import { and, desc, eq, gte, count } from "drizzle-orm";
import { sendPendingLeads } from "./mailer.service";
import { runScrapeJob } from "./scraper.service";
import { incrementUsage } from "../lib/helpers";
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
  if (!sub) throw Object.assign(new Error("No subscription found"), { statusCode: 404 });
  return sub;
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
      { statusCode: 400 }
    );
  }

  if (!copilot.emailProfileId) {
    throw Object.assign(
      new Error("Email profile is not properly configured"),
      { statusCode: 400 }
    );
  }

  const [profile] = await db
    .select()
    .from(emailProfiles)
    .where(eq(emailProfiles.id, copilot.emailProfileId));

  if (!profile || !profile.smtpHost || !profile.email || !profile.smtpPass) {
    throw Object.assign(
      new Error("Email profile is not properly configured"),
      { statusCode: 400 }
    );
  }
}

export async function listCopilots(userId: number) {
  return db.select().from(copilots).where(eq(copilots.userId, userId));
}

export async function getCopilot(id: number, userId: number) {
  const [row] = await db
    .select()
    .from(copilots)
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)));
  if (!row) throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  return row;
}

export async function createCopilot(userId: number, data: CreateCopilotInput) {
  const sub = await getActiveSubscription(userId);
  const [created] = await db
    .insert(copilots)
    .values({ ...data, userId })
    .returning();
  await incrementUsage(userId, sub.id, { copilotsCreated: 1 });
  return created;
}

export async function updateCopilot(id: number, userId: number, data: UpdateCopilotInput) {
  const [updated] = await db
    .update(copilots)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)))
    .returning();
  if (!updated) throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  return updated;
}

export async function deleteCopilot(id: number, userId: number) {
  await db.delete(copilots).where(and(eq(copilots.id, id), eq(copilots.userId, userId)));
}

export async function duplicateCopilot(id: number, userId: number) {
  const [original] = await db
    .select()
    .from(copilots)
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)));

  if (!original) {
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  }

  const sub = await getActiveSubscription(userId);

  const newName = original.name.length > 140
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

  return created;
}

export async function updateCopilotStatus(
  id: number,
  userId: number,
  data: UpdateCopilotStatusInput
) {
  const [updated] = await db
    .update(copilots)
    .set({ status: data.status, updatedAt: new Date() })
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)))
    .returning();
  if (!updated) throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });

  if (data.status === "active") {
    await validateCopilotCanActivate(id);
  }

  return updated;
}

export async function runCopilot(id: number, userId: number) {
  const [copilot] = await db
    .select()
    .from(copilots)
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)));

  if (!copilot) {
    throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  }

  console.log(` ${new Date().toLocaleTimeString()} - 🚀 Triggering copilot ${id} for user ${userId}`);

  await db
    .update(copilots)
    .set({
      status: "running",
      lastRunAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)));

  if (copilot.scrapeProfileId) {
    const [profile] = await db
      .select()
      .from(scrapeProfiles)
      .where(eq(scrapeProfiles.id, copilot.scrapeProfileId));
    if (profile) {
      console.log(` ${new Date().toLocaleTimeString()} - 🔍 Starting scrape job for copilot ${id} with limit ${copilot.sendLimit}`);
      runScrapeJob(profile, undefined, copilot.sendLimit)
        .then((scrapeJob) => {
          console.log(` ${new Date().toLocaleTimeString()} - 📋 Scrape job ${scrapeJob.id} completed for copilot ${id}`);
          db.update(copilots)
            .set({ lastJobId: scrapeJob.id, updatedAt: new Date() })
            .where(eq(copilots.id, id))
            .catch(console.error);
        })
        .catch((err) => {
          console.error(` ${new Date().toLocaleTimeString()} - ⚠️ Scrape job failed for copilot ${id}:`, err);
          db.update(copilots)
            .set({ status: "paused", lastError: "Scrape job failed: " + err.message, updatedAt: new Date() })
            .where(eq(copilots.id, id))
            .catch(console.error);
        })
        .finally(() => {
          console.log(` ${new Date().toLocaleTimeString()} - 📧 Starting email job for copilot ${id}`);
          sendPendingLeads(id)
            .then(() => {
              console.log(` ${new Date().toLocaleTimeString()} - ✅ Email job completed for copilot ${id}`);
              db.update(copilots)
                .set({ status: "completed", updatedAt: new Date() })
                .where(eq(copilots.id, id))
                .catch(console.error);
            })
            .catch((err) => {
              console.error(` ${new Date().toLocaleTimeString()} - ❌ Email job failed for copilot ${id}:`, err);
              db.update(copilots)
                .set({ status: "paused", lastError: "Email job failed: " + err.message, updatedAt: new Date() })
                .where(eq(copilots.id, id))
                .catch(console.error);
            });
        });
    }
  }



  return {
    message: "Copilot triggered successfully",
    copilotId: id,
    status: "running",
  };
}

export async function getCopilotStatus(id: number, userId: number) {
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
          gte(emailLogs.sentAt, startOfDay)
        )
      );

    emailStats = {
      sentToday: Number(stats?.sent ?? 0),
    };
  }

  const newLeadsCount = await db
    .select({ count: count() })
    .from(leads)
    .where(and(eq(leads.userId, userId), eq(leads.status, "new")));

  return {
    id: copilot.id,
    name: copilot.name,
    status: copilot.status,
    lastRunAt: copilot.lastRunAt,
    lastError: copilot.lastError,
    emailsSent: copilot.emailsSent,
    emailsOpened: copilot.emailsOpened,
    emailsReplied: copilot.emailsReplied,
    newLeadsCount: Number(newLeadsCount[0]?.count ?? 0),
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
  };
}
