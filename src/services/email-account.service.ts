import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { emailProfilesTable, subscriptionsTable } from "../db/schema";
import { and, count, desc, eq } from "drizzle-orm";
import { testSmtpConnection, type SendResult } from "./mailer.service";
import { incrementUsage } from "../lib/helpers";
import { getPlanLimits, isSubscriptionUsable } from "../lib/billing";
import type {
  CreateEmailProfileInput,
  UpdateEmailProfileInput,
} from "../validators/email-profile.validator";

export async function listEmailProfiles(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const rows = await db
    .select()
    .from(emailProfilesTable)
    .where(eq(emailProfilesTable.userId, userId));
  res.json(rows);
}

export async function getEmailProfile(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [row] = await db
    .select()
    .from(emailProfilesTable)
    .where(and(eq(emailProfilesTable.userId, userId), eq(emailProfilesTable.id, id)));
  if (!row)
    throw Object.assign(new Error("Email profile not found"), {
      statusCode: 404,
    });
  res.json(row);
}

async function getUsableSubscription(userId: number) {
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .orderBy(desc(subscriptionsTable.createdAt))
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
    .from(emailProfilesTable)
    .where(eq(emailProfilesTable.userId, userId));

  if (profilesCount >= limits.emailProfiles) {
    throw Object.assign(
      new Error(
        `Plan limit reached: max ${limits.emailProfiles} email profiles on ${planId}`,
      ),
      { statusCode: 403 },
    );
  }
}

export async function createEmailProfile(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const data = req.body as CreateEmailProfileInput;

  const sub = await getUsableSubscription(userId);
  await assertEmailProfileWithinPlanLimit(userId, sub.planId);

  const [created] = await db
    .insert(emailProfilesTable)
    .values({ ...data, userId })
    .returning();
  await incrementUsage(userId, sub.id, { emailProfilesCreated: 1 });
  res.status(201).json(created);
}

export async function updateEmailProfile(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;
  const data = req.body as UpdateEmailProfileInput;

  const [updated] = await db
    .update(emailProfilesTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(emailProfilesTable.userId, userId), eq(emailProfilesTable.id, id)))
    .returning();
  if (!updated)
    throw Object.assign(new Error("Email profile not found"), {
      statusCode: 404,
    });
  res.json(updated);
}

export async function deleteEmailProfile(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  await db
    .delete(emailProfilesTable)
    .where(and(eq(emailProfilesTable.userId, userId), eq(emailProfilesTable.id, id)));
  res.status(204).send();
}

/** Verifies the SMTP config stored in the given profile (not global settings). */
async function verifyEmailProfileForUser(
  id: number,
  userId: number,
): Promise<SendResult> {
  const [profile] = await db
    .select()
    .from(emailProfilesTable)
    .where(and(eq(emailProfilesTable.userId, userId), eq(emailProfilesTable.id, id)));
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
      .update(emailProfilesTable)
      .set({
        status: "active",
        lastVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(emailProfilesTable.userId, userId), eq(emailProfilesTable.id, id)));
  } else {
    await db
      .update(emailProfilesTable)
      .set({ status: "error", updatedAt: new Date() })
      .where(and(eq(emailProfilesTable.userId, userId), eq(emailProfilesTable.id, id)));
  }

  return result;
}

export async function verifyEmailProfile(
  req: Request<{ id: string }>,
  res: Response,
) {
  const result = await verifyEmailProfileForUser(
    Number(req.params.id),
    req.dbUser!.id,
  );
  res.json(result);
}

/** @internal Used by scripts/tests — not an HTTP handler. */
export { verifyEmailProfileForUser };
