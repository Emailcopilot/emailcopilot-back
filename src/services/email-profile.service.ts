import { db } from "../db/drizzle";
import { emailProfiles } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { testSmtpConnection, type SendResult } from "./mailer.service";
import { incrementUsage } from "../lib/helpers";
import type {
  CreateEmailProfileInput,
  UpdateEmailProfileInput,
} from "../validators/email-profile.validator";

export async function listEmailProfiles(userId: number) {
  return db.select().from(emailProfiles).where(eq(emailProfiles.userId, userId));
}

export async function getEmailProfile(id: number, userId: number) {
  const [row] = await db
    .select()
    .from(emailProfiles)
    .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)));
  if (!row) throw Object.assign(new Error("Email profile not found"), { statusCode: 404 });
  return row;
}

export async function createEmailProfile(
  userId: number,
  subscriptionId: number,
  data: CreateEmailProfileInput
) {
  const [created] = await db
    .insert(emailProfiles)
    .values({ ...data, userId })
    .returning();
  await incrementUsage(userId, subscriptionId, { emailProfilesCreated: 1 });
  return created;
}

export async function updateEmailProfile(
  id: number,
  userId: number,
  data: UpdateEmailProfileInput
) {
  const [updated] = await db
    .update(emailProfiles)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)))
    .returning();
  if (!updated) throw Object.assign(new Error("Email profile not found"), { statusCode: 404 });
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
export async function verifyEmailProfile(id: number, userId: number): Promise<SendResult> {
  const [profile] = await db
    .select()
    .from(emailProfiles)
    .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)));
  if (!profile) throw Object.assign(new Error("Email profile not found"), { statusCode: 404 });

  // Validate SMTP config exists before testing
  if (!profile.smtpHost || !profile.email || !profile.smtpPass) {
    throw Object.assign(
      new Error("SMTP configuration incomplete. smtpHost, email, and smtpPass are required."),
      { statusCode: 400 }
    );
  }

  // Pass the profile's own SMTP config to the tester
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
      .set({ status: "active", lastVerifiedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)));
  } else {
    await db
      .update(emailProfiles)
      .set({ status: "error", updatedAt: new Date() })
      .where(and(eq(emailProfiles.userId, userId), eq(emailProfiles.id, id)));
  }

  return result;
}
