import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { emailAccountTable, subscriptionsTable } from "../db/schema";
import { and, count, desc, eq } from "drizzle-orm";
import { testSmtpConnection, type SendResult } from "./mailer.service";
import { incrementUsage } from "../lib/helpers";
import { getPlanLimits, isSubscriptionUsable } from "../lib/billing";
import type {
  CreateEmailAccountInput,
  UpdateEmailAccountInput,
} from "../validators/email-account.validator";

export async function listEmailAccounts(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const rows = await db
    .select()
    .from(emailAccountTable)
    .where(eq(emailAccountTable.userId, userId));
  res.json(rows);
}

export async function getEmailAccount(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [row] = await db
    .select()
    .from(emailAccountTable)
    .where(and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)));
  if (!row)
    throw Object.assign(new Error("Email account not found"), {
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

async function assertEmailAccountWithinPlanLimit(
  userId: number,
  planId: string,
) {
  const limits = getPlanLimits(planId);
  if (!limits || limits.emailAccounts === null) return;

  const [{ accountsCount }] = await db
    .select({ accountsCount: count() })
    .from(emailAccountTable)
    .where(eq(emailAccountTable.userId, userId));

  if (accountsCount >= limits.emailAccounts) {
    throw Object.assign(
      new Error(
        `Plan limit reached: max ${limits.emailAccounts} email accounts on ${planId}`,
      ),
      { statusCode: 403 },
    );
  }
}

export async function createEmailAccount(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const data = req.body as CreateEmailAccountInput;

  const sub = await getUsableSubscription(userId);
  await assertEmailAccountWithinPlanLimit(userId, sub.planId);

  const [created] = await db
    .insert(emailAccountTable)
    .values({ ...data, userId })
    .returning();
  await incrementUsage(userId, sub.id, { emailAccountsCreated: 1 });
  res.status(201).json(created);
}

export async function updateEmailAccount(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;
  const data = req.body as UpdateEmailAccountInput;

  const [updated] = await db
    .update(emailAccountTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)))
    .returning();
  if (!updated)
    throw Object.assign(new Error("Email account not found"), {
      statusCode: 404,
    });
  res.json(updated);
}

export async function deleteEmailAccount(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  await db
    .delete(emailAccountTable)
    .where(and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)));
  res.status(204).send();
}

/** Verifies the SMTP config stored in the given account (not global settings). */
async function verifyEmailAccountForUser(
  id: number,
  userId: number,
): Promise<SendResult> {
  const [account] = await db
    .select()
    .from(emailAccountTable)
    .where(and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)));
  if (!account)
    throw Object.assign(new Error("Email account not found"), {
      statusCode: 404,
    });

  if (!account.smtpHost || !account.email || !account.smtpPass) {
    throw Object.assign(
      new Error(
        "SMTP configuration incomplete. smtpHost, email, and smtpPass are required.",
      ),
      { statusCode: 400 },
    );
  }

  const result = await testSmtpConnection({
    host: account.smtpHost,
    port: account.smtpPort ?? 587,
    email: account.email,
    pass: account.smtpPass,
    sendName: account.sendName ?? account.email,
  });

  if (result.success) {
    await db
      .update(emailAccountTable)
      .set({
        status: "active",
        lastVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)));
  } else {
    await db
      .update(emailAccountTable)
      .set({ status: "error", updatedAt: new Date() })
      .where(and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)));
  }

  return result;
}

export async function verifyEmailAccount(
  req: Request<{ id: string }>,
  res: Response,
) {
  const result = await verifyEmailAccountForUser(
    Number(req.params.id),
    req.dbUser!.id,
  );
  res.json(result);
}

/** @internal Used by scripts/tests — not an HTTP handler. */
export { verifyEmailAccountForUser };
