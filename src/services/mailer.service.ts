import nodemailer from "nodemailer";
import {
  emailTemplatesTable,
  emailAccountTable,
  copilotsTable,
  copilotLeadsTable,
  leadsTable,
  sentEmailsTable,
} from "../db/schema";
import { eq, and, sql, asc, isNotNull, ne } from "drizzle-orm";
import type { EmailTemplate } from "../db/types";
import { db } from "../db/drizzle";
import { incrementUsage } from "../lib/helpers";
import {
  getActiveSubscription,
  getCopilotProgress,
  getLastCopilotSendAt,
  getRunningCopilots,
  pauseCopilot,
  setCopilotActive,
  syncCopilotsDailyStatus,
} from "./copilot-lifecycle.service";
import { OUTSIDE_SEND_WINDOW_MSG } from "../lib/send-window";
import { resolveMailTransport, testMailTransport } from "./email-transport.service";

// ─── Types ────────────────────────────────────────────────────────────────────

/** @deprecated Prefer testMailTransport with a full account; kept for scripts. */
interface SmtpConfig {
  host: string;
  port: number;
  email: string;
  pass: string;
  sendName: string;
}

export interface SendResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

// ─── Config helpers ───────────────────────────────────────────────────────────

async function getCopilotEmailAccount(copilotId: number) {
  const [copilot] = await db
    .select()
    .from(copilotsTable)
    .where(eq(copilotsTable.id, copilotId));

  if (!copilot || !copilot.emailAccountId) {
    throw new Error("Copilot has no email account configured.");
  }

  const [account] = await db
    .select()
    .from(emailAccountTable)
    .where(eq(emailAccountTable.id, copilot.emailAccountId));

  if (!account) {
    throw new Error("Email account not found.");
  }

  return { copilot, account };
}

async function getCopilotTemplate(copilotId: number): Promise<EmailTemplate> {
  const [copilot] = await db
    .select()
    .from(copilotsTable)
    .where(eq(copilotsTable.id, copilotId));

  if (!copilot || !copilot.templateId) {
    throw new Error("Copilot has no template configured.");
  }

  const [template] = await db
    .select()
    .from(emailTemplatesTable)
    .where(eq(emailTemplatesTable.id, copilot.templateId));

  if (!template) {
    throw new Error("Template not found.");
  }

  return template;
}

type LeadLike = {
  id?: number;
  companyName: string | null;
  email: string | null;
  website: string | null;
  phone: string | null;
};

function interpolate(text: string, lead: LeadLike, sendName: string): string {
  return text
    .replace(/{{companyName}}/g, lead.companyName ?? "")
    .replace(/{{email}}/g, lead.email ?? "")
    .replace(/{{website}}/g, lead.website ?? "")
    .replace(/{{phone}}/g, lead.phone ?? "")
    .replace(/{{senderName}}/g, sendName);
}

const MIN_SEND_INTERVAL_MS = 2 * 60 * 1000;
const MAX_SEND_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_POLL_MS = 30 * 1000;

// ─── SMTP test (legacy / scripts) ─────────────────────────────────────────────

function createTransporter(config: SmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.email, pass: config.pass },
  });
}

export async function testSmtpConnection(
  config: SmtpConfig,
): Promise<SendResult> {
  try {
    const transporter = createTransporter(config);
    await transporter.verify();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export { testMailTransport };

const randomBetween = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

// ─── Send ─────────────────────────────────────────────────────────────────────

async function sendCopilotLead(
  copilotId: number,
  copilotLeadId: number,
  lead: LeadLike,
  template: EmailTemplate,
  sequenceStep = 0,
): Promise<SendResult> {
  const toEmail = lead.email as string;
  let subject = "";
  let body = "";
  let emailAccountId: number | null = null;

  try {
    const { copilot, account } = await getCopilotEmailAccount(copilotId);
    emailAccountId = account.id;
    const mail = await resolveMailTransport(account);
    subject = interpolate(template.subject ?? "", lead, mail.sendName);
    body = interpolate(template.body ?? "", lead, mail.sendName);

    const info = await mail.transporter.sendMail({
      from: `"${mail.sendName}" <${mail.email}>`,
      to: toEmail,
      subject,
      html: body,
    });

    const messageId = info.messageId ?? null;
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(sentEmailsTable).values({
        copilotId,
        copilotLeadId,
        leadId: lead.id ?? null,
        emailAccountId: account.id,
        templateId: template.id,
        sequenceStep,
        toEmail,
        subject,
        body,
        messageId,
        status: "sent",
        sentAt: now,
      });

      await tx
        .update(copilotLeadsTable)
        .set({
          status: "sent",
          currentStep: sequenceStep,
          sentAt: now,
          updatedAt: now,
        })
        .where(eq(copilotLeadsTable.id, copilotLeadId));

      await tx
        .update(copilotsTable)
        .set({
          emailsSent: sql`${copilotsTable.emailsSent} + 1`,
          lastRunAt: now,
          updatedAt: now,
        })
        .where(eq(copilotsTable.id, copilotId));
    });

    const subscription = await getActiveSubscription(copilot.userId);
    if (subscription) {
      await incrementUsage(copilot.userId, subscription.subscriptionId, {
        emailsSent: 1,
      });
    }

    console.log(`✅ Email sent to ${toEmail} (${lead.companyName})`);
    return { success: true, messageId: messageId ?? undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(sentEmailsTable).values({
        copilotId,
        copilotLeadId,
        leadId: lead.id ?? null,
        emailAccountId,
        templateId: template.id,
        sequenceStep,
        toEmail,
        subject: subject || template.subject,
        body: body || template.body,
        status: "failed",
        failedAt: now,
        errorMessage: message,
      });

      await tx
        .update(copilotLeadsTable)
        .set({
          status: "failed",
          failedAt: now,
          errorMessage: message,
          updatedAt: now,
        })
        .where(eq(copilotLeadsTable.id, copilotLeadId));
    });

    console.error(`❌ Failed to send to ${toEmail}: ${message}`);
    return { success: false, error: message };
  }
}

async function canSendForCopilot(copilotId: number): Promise<boolean> {
  const lastSentAt = await getLastCopilotSendAt(copilotId);
  if (!lastSentAt) {
    return true;
  }

  const elapsed = Date.now() - lastSentAt.getTime();
  return elapsed >= MIN_SEND_INTERVAL_MS;
}

async function periodicSend(): Promise<boolean> {
  await syncCopilotsDailyStatus();

  const runningCopilots = await getRunningCopilots();

  if (runningCopilots.length === 0) {
    return false;
  }

  for (const copilot of runningCopilots) {
    const subscription = await getActiveSubscription(copilot.userId);

    if (!subscription) {
      await pauseCopilot(copilot.id, "No active subscription");
      continue;
    }

    if (subscription.remainingEmails <= 0) {
      await pauseCopilot(copilot.id, "Monthly email limit reached");
      continue;
    }

    const progress = await getCopilotProgress(copilot, subscription);

    if (!progress.withinSendWindow) {
      await setCopilotActive(copilot.id, OUTSIDE_SEND_WINDOW_MSG);
      continue;
    }

    if (progress.dailyLimitReached) {
      await setCopilotActive(
        copilot.id,
        "Daily send limit reached — will resume when quota resets",
      );
      continue;
    }

    if (!(await canSendForCopilot(copilot.id))) {
      continue;
    }

    const [pendingLead] = await db
      .select({
        copilotLeadId: copilotLeadsTable.id,
        lead: leadsTable,
      })
      .from(copilotLeadsTable)
      .innerJoin(leadsTable, eq(copilotLeadsTable.leadId, leadsTable.id))
      .where(
        and(
          eq(copilotLeadsTable.copilotId, copilot.id),
          eq(copilotLeadsTable.status, "new"),
          isNotNull(leadsTable.email),
          ne(leadsTable.email, ""),
        ),
      )
      .orderBy(asc(copilotLeadsTable.createdAt))
      .limit(1);

    if (!pendingLead?.lead.email) {
      continue;
    }

    let template: EmailTemplate;
    try {
      template = await getCopilotTemplate(copilot.id);
    } catch {
      await pauseCopilot(copilot.id, "No email template configured");
      continue;
    }

    try {
      await getCopilotEmailAccount(copilot.id);
    } catch {
      await pauseCopilot(copilot.id, "Email profile not configured");
      continue;
    }

    console.log(
      `📧 Sending email for copilot ${copilot.id} to ${pendingLead.lead.email} (${pendingLead.lead.companyName})`,
    );

    await sendCopilotLead(
      copilot.id,
      pendingLead.copilotLeadId,
      pendingLead.lead,
      template,
      0,
    );

    const afterSend = await getCopilotProgress(copilot, subscription);
    if (!afterSend.withinSendWindow) {
      await setCopilotActive(copilot.id, OUTSIDE_SEND_WINDOW_MSG);
    } else if (afterSend.dailyLimitReached) {
      await setCopilotActive(
        copilot.id,
        "Daily send limit reached — will resume when quota resets",
      );
    }

    return true;
  }

  return false;
}

export function periodicSendScheduler() {
  const scheduleNext = (delayMs?: number) => {
    const waitMs =
      delayMs ?? randomBetween(MIN_SEND_INTERVAL_MS, MAX_SEND_INTERVAL_MS);

    setTimeout(async () => {
      try {
        const sent = await periodicSend();
        scheduleNext(
          sent
            ? randomBetween(MIN_SEND_INTERVAL_MS, MAX_SEND_INTERVAL_MS)
            : IDLE_POLL_MS,
        );
      } catch (error) {
        console.error("❌ Periodic send error:", error);
        scheduleNext(IDLE_POLL_MS);
      }
    }, waitMs);
  };

  periodicSend()
    .then((sent) =>
      scheduleNext(
        sent
          ? randomBetween(MIN_SEND_INTERVAL_MS, MAX_SEND_INTERVAL_MS)
          : IDLE_POLL_MS,
      ),
    )
    .catch((error) => {
      console.error("❌ Periodic send error:", error);
      scheduleNext(IDLE_POLL_MS);
    });
}
