import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { emailAccountTable, subscriptionsTable } from "../db/schema";
import { and, count, desc, eq } from "drizzle-orm";
import { testSmtpConnection, type SendResult } from "./mailer.service";
import {
  testImapConnection,
  testMailTransport,
} from "./email-transport.service";
import { incrementUsage } from "../lib/helpers";
import { getPlanLimits, isSubscriptionUsable } from "../lib/billing";
import type {
  CreateEmailAccountInput,
  UpdateEmailAccountInput,
} from "../validators/email-account.validator";
import {
  encryptSecret,
  PROVIDER_PRESETS,
  sanitizeEmailAccount,
} from "../lib/email-secrets";

export type ChannelVerifyResult = {
  success: boolean;
  error?: string;
  skipped?: boolean;
};

export type VerifyEmailAccountResult = {
  success: boolean;
  smtp: ChannelVerifyResult;
  imap: ChannelVerifyResult;
  smtpStatus: string;
  imapStatus: string;
};

function hasImapConfigured(
  account: typeof emailAccountTable.$inferSelect,
): boolean {
  return (
    account.provider === "gmail" ||
    account.provider === "outlook" ||
    Boolean(account.imapHost)
  );
}

export async function listEmailAccounts(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const rows = await db
    .select()
    .from(emailAccountTable)
    .where(eq(emailAccountTable.userId, userId))
    .orderBy(desc(emailAccountTable.createdAt));
  res.json(rows.map(sanitizeEmailAccount));
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
    .where(
      and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)),
    );
  if (!row)
    throw Object.assign(new Error("Email account not found"), {
      statusCode: 404,
    });
  res.json(sanitizeEmailAccount(row));
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

function prepareAccountWrite(
  data: CreateEmailAccountInput | UpdateEmailAccountInput,
) {
  const {
    dailyLimit: _dailyLimit,
    smtpPass,
    imapPass,
    provider,
    ...rest
  } = data as CreateEmailAccountInput & UpdateEmailAccountInput;

  const patch: Record<string, unknown> = { ...rest };

  if (smtpPass !== undefined) {
    patch.smtpPass = smtpPass;
  }
  if (imapPass !== undefined) {
    patch.imapPass = encryptSecret(imapPass);
  }

  if (provider === "gmail" || provider === "outlook") {
    const preset = PROVIDER_PRESETS[provider];
    if (patch.smtpHost === undefined) patch.smtpHost = preset.smtpHost;
    if (patch.smtpPort === undefined) patch.smtpPort = preset.smtpPort;
    if (patch.imapHost === undefined) patch.imapHost = preset.imapHost;
    if (patch.imapPort === undefined) patch.imapPort = preset.imapPort;
  }

  return patch;
}

export async function createEmailAccount(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const data = req.body as CreateEmailAccountInput;

  if (data.provider === "smtp" && (!data.smtpHost || !data.smtpPass)) {
    throw Object.assign(
      new Error("smtpHost and smtpPass are required for SMTP accounts"),
      { statusCode: 400 },
    );
  }

  if (data.provider === "gmail" || data.provider === "outlook") {
    throw Object.assign(
      new Error(
        `Use GET /email-accounts/oauth/${data.provider}/start to connect ${data.provider}`,
      ),
      { statusCode: 400 },
    );
  }

  const sub = await getUsableSubscription(userId);
  await assertEmailAccountWithinPlanLimit(userId, sub.planId);

  const values = prepareAccountWrite(data);
  const imapConfigured = Boolean(
    (values as { imapHost?: string }).imapHost || data.imapHost,
  );

  const [created] = await db
    .insert(emailAccountTable)
    .values({
      ...values,
      userId,
      smtpStatus: "inactive",
      imapStatus: imapConfigured ? "inactive" : "disabled",
    } as typeof emailAccountTable.$inferInsert)
    .returning();
  await incrementUsage(userId, sub.id, { emailAccountsCreated: 1 });
  res.status(201).json(sanitizeEmailAccount(created));
}

export async function updateEmailAccount(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;
  const data = req.body as UpdateEmailAccountInput;

  const values = prepareAccountWrite(data);

  if (data.imapHost !== undefined) {
    values.imapStatus = data.imapHost ? "inactive" : "disabled";
  }

  const [updated] = await db
    .update(emailAccountTable)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)),
    )
    .returning();
  if (!updated)
    throw Object.assign(new Error("Email account not found"), {
      statusCode: 404,
    });
  res.json(sanitizeEmailAccount(updated));
}

export async function deleteEmailAccount(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  await db
    .delete(emailAccountTable)
    .where(
      and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)),
    );
  res.status(204).send();
}

function isAccountConfigured(account: typeof emailAccountTable.$inferSelect) {
  if (account.provider === "gmail" || account.provider === "outlook") {
    return Boolean(account.oauthRefreshToken || account.oauthAccessToken);
  }
  return Boolean(account.smtpHost && account.email && account.smtpPass);
}

/** Verifies SMTP and IMAP independently; updates smtpStatus / imapStatus. */
async function verifyEmailAccountForUser(
  id: number,
  userId: number,
): Promise<VerifyEmailAccountResult> {
  const [account] = await db
    .select()
    .from(emailAccountTable)
    .where(
      and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)),
    );
  if (!account)
    throw Object.assign(new Error("Email account not found"), {
      statusCode: 404,
    });

  if (!isAccountConfigured(account)) {
    throw Object.assign(
      new Error(
        account.provider === "smtp"
          ? "SMTP configuration incomplete. smtpHost, email, and smtpPass are required."
          : "OAuth tokens missing. Reconnect the account via OAuth.",
      ),
      { statusCode: 400 },
    );
  }

  const smtpResult = await testMailTransport(account);
  const smtpStatus = smtpResult.success ? "active" : "error";

  let imapResult: ChannelVerifyResult;
  let imapStatus: "active" | "error" | "disabled" | "inactive";

  if (!hasImapConfigured(account)) {
    imapResult = { success: true, skipped: true };
    imapStatus = "disabled";
  } else {
    const imap = await testImapConnection(account);
    imapResult = {
      success: imap.success,
      error: imap.error,
    };
    imapStatus = imap.success ? "active" : "error";
  }

  const now = new Date();
  const [updated] = await db
    .update(emailAccountTable)
    .set({
      smtpStatus,
      imapStatus,
      lastSmtpError: smtpResult.success
        ? null
        : (smtpResult.error ?? "SMTP verify failed"),
      lastImapError:
        imapStatus === "disabled"
          ? null
          : imapResult.success
            ? null
            : (imapResult.error ?? "IMAP verify failed"),
      lastVerifiedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(emailAccountTable.userId, userId), eq(emailAccountTable.id, id)),
    )
    .returning();

  return {
    success: smtpResult.success && (imapResult.skipped || imapResult.success),
    smtp: smtpResult,
    imap: imapResult,
    smtpStatus: updated?.smtpStatus ?? smtpStatus,
    imapStatus: updated?.imapStatus ?? imapStatus,
  };
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
export { verifyEmailAccountForUser, testSmtpConnection };
export type { SendResult };
