import { db } from "../db/drizzle";
import { emailProfiles, subscriptions } from "../db/schema";
import { and, count, desc, eq } from "drizzle-orm";
import { testSmtpConnection, type SendResult } from "./mailer.service";
import { incrementUsage } from "../lib/helpers";
import { getPlanLimits, isSubscriptionUsable } from "../lib/billing";
import type {
  CreateEmailProfileInput,
  UpdateEmailProfileInput,
} from "../validators/email-profile.validator";

export async function listEmailProfiles(userId: number) {
  return db
    .select()
    .from(emailProfiles)
    .where(eq(emailProfiles.userId, userId));
}

export async function getEmailProfile(id: number, userId: number) {
  const [row] = await db
    .select()
    .from(emailProfiles)
    .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)));
  if (!row)
    throw Object.assign(new Error("Email profile not found"), {
      statusCode: 404,
    });
  return row;
}

async function getUsableSubscription(userId: number) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  if (!sub || !isSubscriptionUsable(sub)) {
    throw Object.assign(new Error("No active subscription found"), {
      statusCode: 403,
    });
  }
  return sub;
}

async function assertEmailProfileWithinPlanLimit(
  userId: number,
  planId: string,
) {
  const limits = getPlanLimits(planId);
  if (!limits || limits.emailProfiles === null) return;

  const [{ profilesCount }] = await db
    .select({ profilesCount: count() })
    .from(emailProfiles)
    .where(eq(emailProfiles.userId, userId));

  if (profilesCount >= limits.emailProfiles) {
    throw Object.assign(
      new Error(
        `Plan limit reached: max ${limits.emailProfiles} email profiles on ${planId}`,
      ),
      { statusCode: 403 },
    );
  }
}

export async function createEmailProfile(
  userId: number,
  data: CreateEmailProfileInput,
) {
  const sub = await getUsableSubscription(userId);
  await assertEmailProfileWithinPlanLimit(userId, sub.planId);

  const [created] = await db
    .insert(emailProfiles)
    .values({ ...data, userId })
    .returning();
  await incrementUsage(userId, sub.id, { emailProfilesCreated: 1 });
  return created;
}

export async function updateEmailProfile(
  id: number,
  userId: number,
  data: UpdateEmailProfileInput,
) {
  const [updated] = await db
    .update(emailProfiles)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)))
    .returning();
  if (!updated)
    throw Object.assign(new Error("Email profile not found"), {
      statusCode: 404,
    });
  return updated;
}

export async function deleteEmailProfile(id: number, userId: number) {
  await db
    .delete(emailProfiles)
    .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)));
}

/**
 * Verifies the SMTP config stored in the given profile (not global settings).
 * Updates the profile status based on the result.
 */
export async function verifyEmailProfile(
  id: number,
  userId: number,
): Promise<SendResult> {
  const [profile] = await db
    .select()
    .from(emailProfiles)
    .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)));
  if (!profile)
    throw Object.assign(new Error("Email profile not found"), {
      statusCode: 404,
    });

  if (!profile.smtpHost || !profile.email || !profile.smtpPass) {
    throw Object.assign(
      new Error(
        "SMTP configuration incomplete. smtpHost, email, and smtpPass are required.",
      ),
      { statusCode: 400 },
    );
  }

  const result = await testSmtpConnection({
    host: profile.smtpHost,
    port: profile.smtpPort ?? 587,
    email: profile.email,
    pass: profile.smtpPass,
    sendName: profile.sendName ?? profile.email,
  });

  if (result.success) {
    await db
      .update(emailProfiles)
      .set({
        status: "active",
        lastVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)));
  } else {
    await db
      .update(emailProfiles)
      .set({ status: "error", updatedAt: new Date() })
      .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)));
  }

  return result;
}
