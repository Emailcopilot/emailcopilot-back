import nodemailer from "nodemailer";
import { leads, emailTemplates, emailLogs, emailProfiles, copilots } from "../db/schema";
import { eq, gte, and, count, inArray, sql, or } from "drizzle-orm";
import type { Lead, EmailTemplate } from "../db/types";
import { db } from "../db/drizzle";

// ─── Types ────────────────────────────────────────────────────────────────────
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
}

// ─── SMTP helpers ─────────────────────────────────────────────────────────

/**
 * Gets SMTP config from the copilot's linked email profile.
 */
async function getCopilotSmtpConfig(copilotId: number): Promise<SmtpConfig> {
  const [copilot] = await db
    .select()
    .from(copilots)
    .where(eq(copilots.id, copilotId));

  if (!copilot || !copilot.emailProfileId) {
    throw new Error("Copilot has no email profile configured.");
  }

  const [profile] = await db
    .select()
    .from(emailProfiles)
    .where(eq(emailProfiles.id, copilot.emailProfileId));

  if (!profile || !profile.smtpHost || !profile.email || !profile.smtpPass) {
    throw new Error("Email profile not properly configured.");
  }

  return {
    host: profile.smtpHost,
    port: profile.smtpPort ?? 587,
    email: profile.email,
    pass: profile.smtpPass,
    sendName: profile.sendName ?? profile.email,
  };
}

/**
 * Gets the template linked to the copilot.
 */
async function getCopilotTemplate(copilotId: number): Promise<EmailTemplate> {
  const [copilot] = await db
    .select()
    .from(copilots)
    .where(eq(copilots.id, copilotId));

  if (!copilot || !copilot.templateId) {
    throw new Error("Copilot has no template configured.");
  }

  const [template] = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.id, copilot.templateId));

  if (!template) {
    throw new Error("Template not found.");
  }

return template;
}

// ─── SMTP helpers ─────────────────────────────────────────────────────────────

/**
 * Reads SMTP config from the emailProfiles table.
 * Retrieves the first active email profile.
 */
async function getGlobalSmtpConfig(): Promise<SmtpConfig> {
  const profile = await db.query.emailProfiles.findFirst({
    where: eq(emailProfiles.status, "active"),
  });

  if (!profile || !profile.smtpHost || !profile.email || !profile.smtpPass) {
    throw new Error(
      "No active email profile configured. Please set up an active SMTP email profile."
    );
  }

  return {
    host: profile.smtpHost,
    port: profile.smtpPort ?? 587,
    email: profile.email,
    pass: profile.smtpPass,
    sendName: profile.sendName ?? profile.email, // Fallback to email if sendName is not set
  };
}

/**
 * Creates a Nodemailer transporter instance configured with SMTP settings.
 * 
 * @param config - SMTP configuration object containing connection details
 * @param config.host - The SMTP server hostname
 * @param config.port - The SMTP server port number
 * @param config.email - The SMTP authentication email (typically an email address)
 * @param config.pass - The SMTP authentication password
 * @returns A configured Transporter instance ready to send emails
 * 
 * @example
 * const transporter = createTransporter({
 *   host: 'smtp.gmail.com',
 *   port: 587,
 *   email: 'your-email@gmail.com',
 *   pass: 'your-app-password'
 * });
 */
function createTransporter(config: SmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.email, pass: config.pass },
  });
}

function interpolate(text: string, lead: Lead, sendName: string): string {
  return text
    .replace(/{{companyName}}/g, lead.companyName ?? "")
    .replace(/{{email}}/g, lead.email ?? "")
    .replace(/{{website}}/g, lead.website ?? "")
    .replace(/{{phone}}/g, lead.phone ?? "")
    .replace(/{{senderName}}/g, sendName);
}

// ─── Core send ────────────────────────────────────────────────────────────────
async function sendEmail(
  copilotId: number,
  lead: Lead,
  template: EmailTemplate
): Promise<SendResult> {
  try {
    const config = await getCopilotSmtpConfig(copilotId);
    const transporter = createTransporter(config);
    const subject = interpolate(template.subject ?? "", lead, config.sendName);
    const body = interpolate(template.body ?? "", lead, config.sendName);

    await transporter.sendMail({
      from: `"${config.sendName}" <${config.email}>`,
      to: lead.email as string,
      subject,
      text: body,
    });

    await db.insert(emailLogs).values({
      leadId: lead.id,
      usersId: template.userId,
      templateId: template.id,
      subject,
      status: "sent",
    });
    await db.update(leads).set({ status: "sent", emailedAt: new Date() }).where(eq(leads.id, lead.id));

    console.log(`✅ Email sent to ${lead.email} (${lead.companyName})`);

    await db
      .update(copilots)
      .set({ emailsSent: sql`${copilots.emailsSent} + 1` })
      .where(eq(copilots.id, copilotId));

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await db.insert(emailLogs).values({
      leadId: lead.id,
      usersId: template.userId,
      templateId: template.id,
      subject: template.subject,
      status: "failed",
      errorMessage: message,
    });
    console.error(`❌ Failed to send to ${lead.email}: ${message}`);
    return { success: false, error: message };
  }
}

// ─── Send pending leads ───────────────────────────────────────────────────────
export async function sendPendingLeads(copilotId: number): Promise<void> {
  console.log("📧 Daily send job started...");

  let template: EmailTemplate;
  try {
    template = await getCopilotTemplate(copilotId);
  } catch (err) {
    console.error("❌ No template configured for copilot.");
    return;
  }

  let smtpConfig: SmtpConfig;
  try {
    smtpConfig = await getCopilotSmtpConfig(copilotId);
  } catch (err) {
    console.error("❌ No email profile configured for copilot.");
    return;
  }

  const [copilot] = await db.select().from(copilots).where(eq(copilots.id, copilotId));
  const limit = copilot?.sendLimit ?? 0;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [{ sentToday }] = await db
    .select({ sentToday: count() })
    .from(emailLogs)
    .where(and(eq(emailLogs.status, "sent"), gte(emailLogs.sentAt, startOfDay)));

  const remaining = limit - Number(sentToday);
  if (remaining <= 0) {
    console.log(`📭 Daily limit of ${limit} already reached.`);
    return;
  }

  console.log(`📬 Sending up to ${remaining} emails (${sentToday}/${limit} sent today)`);

  const pendingLeads = await db.query.leads.findMany({
    where: or(eq(leads.status, "new"), eq(leads.status, "queued")),
    orderBy: leads.scrapedAt,
    limit: remaining,
  });

  if (pendingLeads.length === 0) {
    console.log("📭 No new leads to email.");
    return;
  }

  const pendingIds = pendingLeads.map((l) => l.id);
  await db
    .update(leads)
    .set({ status: "queued" })
    .where(inArray(leads.id, pendingIds));

  for (let i = 0; i < pendingLeads.length; i++) {
    const lead = pendingLeads[i];

    const alreadySent = await db.query.emailLogs.findFirst({
      where: and(
        eq(emailLogs.leadId, lead.id),
        eq(emailLogs.status, "sent"),
        gte(emailLogs.sentAt, startOfDay)
      ),
    });

    if (alreadySent) {
      console.log(`⏭️  Lead ${lead.id} already sent today — marking as "sent"`);
      await db.update(leads).set({ status: "sent" }).where(eq(leads.id, lead.id));
      continue;
    }

    if (i > 0) {
      const delayMs = randomBetween(2 * 60 * 1000, 5 * 60 * 1000);
      console.log(`⏳ Waiting ${Math.round(delayMs / 1000)}s before next send...`);
      await sleep(delayMs);
    }
    await sendEmail(copilotId, lead, template);
  }

  console.log("✅ Daily send job complete.");
}

// ─── SMTP test ────────────────────────────────────────────────────────────────

/**
 * Tests an SMTP connection with an explicit config.
 */
export async function testSmtpConnection(config: SmtpConfig): Promise<SendResult> {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;
