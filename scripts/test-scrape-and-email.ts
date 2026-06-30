/**
 * Integration smoke test: scrape a few Google Maps leads, then send one email via Ethereal SMTP.
 * Run: pnpm exec ts-node scripts/test-scrape-and-email.ts
 */
import "dotenv/config";
import nodemailer from "nodemailer";
import { db } from "../src/db/drizzle";
import {
  users,
  scrapeProfiles,
  emailProfiles,
  emailTemplates,
  copilots,
  leads,
  emailLogs,
} from "../src/db/schema";
import { eq, desc, and, gte } from "drizzle-orm";
import { runScrapeJob } from "../src/services/scraper.service";
import { sendPendingLeads, testSmtpConnection } from "../src/services/mailer.service";

const SCRAPE_LIMIT = 2;
const SEARCH_QUERY = "coffee shop Amsterdam";

type SmtpTestAccount = { user: string; pass: string; smtp: { host: string; port: number } };

async function resolveSmtpAccount(
  emailProfile: typeof emailProfiles.$inferSelect | undefined
): Promise<{ account: SmtpTestAccount; reused: boolean }> {
  if (
    emailProfile?.smtpHost &&
    emailProfile.email &&
    emailProfile.smtpPass
  ) {
    const existing: SmtpTestAccount = {
      user: emailProfile.email,
      pass: emailProfile.smtpPass,
      smtp: { host: emailProfile.smtpHost, port: emailProfile.smtpPort ?? 587 },
    };

    const check = await testSmtpConnection({
      host: existing.smtp.host,
      port: existing.smtp.port,
      email: existing.user,
      pass: existing.pass,
      sendName: emailProfile.sendName ?? existing.user,
    });

    if (check.success) {
      console.log("ℹ️  Reusing existing SMTP account:", existing.user);
      return { account: existing, reused: true };
    }

    console.log("⚠️  Existing SMTP account failed — creating new Ethereal account");
  }

  const testAccount = await nodemailer.createTestAccount();
  console.log("✅ Ethereal test SMTP account:", testAccount.user);

  return {
    account: {
      user: testAccount.user,
      pass: testAccount.pass,
      smtp: { host: testAccount.smtp.host, port: testAccount.smtp.port },
    },
    reused: false,
  };
}

async function ensureTestData() {
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, "integration-test@emailcopilot.local"));

  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        clerkId: "test_clerk_integration",
        email: "integration-test@emailcopilot.local",
        firstName: "Integration",
        lastName: "Test",
      })
      .returning();
    console.log("✅ Created test user", user.id);
  } else {
    console.log("ℹ️  Using existing test user", user.id);
  }

  let [scrapeProfile] = await db
    .select()
    .from(scrapeProfiles)
    .where(eq(scrapeProfiles.userId, user.id))
    .limit(1);

  if (!scrapeProfile) {
    [scrapeProfile] = await db
      .insert(scrapeProfiles)
      .values({
        userId: user.id,
        name: "Integration test scrape",
        searchQuery: SEARCH_QUERY,
        status: "idle",
      })
      .returning();
    console.log("✅ Created scrape profile", scrapeProfile.id);
  }

  let [emailProfile] = await db
    .select()
    .from(emailProfiles)
    .where(eq(emailProfiles.userId, user.id))
    .limit(1);

  const { account: testAccount, reused } = await resolveSmtpAccount(emailProfile);

  if (!emailProfile) {
    [emailProfile] = await db
      .insert(emailProfiles)
      .values({
        userId: user.id,
        profileName: "Ethereal test",
        email: testAccount.user,
        sendName: "Email Copilot Test",
        provider: "smtp",
        smtpHost: testAccount.smtp.host,
        smtpPort: testAccount.smtp.port,
        smtpPass: testAccount.pass,
        status: "active",
      })
      .returning();
    console.log("✅ Created email profile", emailProfile.id);
  } else if (!reused) {
    [emailProfile] = await db
      .update(emailProfiles)
      .set({
        email: testAccount.user,
        smtpHost: testAccount.smtp.host,
        smtpPort: testAccount.smtp.port,
        smtpPass: testAccount.pass,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(emailProfiles.id, emailProfile.id))
      .returning();
    console.log("✅ Updated email profile SMTP creds", emailProfile.id);
  }

  let [template] = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.userId, user.id))
    .limit(1);

  if (!template) {
    [template] = await db
      .insert(emailTemplates)
      .values({
        userId: user.id,
        name: "Integration test template",
        subject: "Hello from {{companyName}} test",
        body: "Hi,\n\nThis is an integration test email for {{companyName}}.\n\n— {{senderName}}",
        category: "Cold Outreach",
        variables: ["companyName", "senderName"],
      })
      .returning();
    console.log("✅ Created template", template.id);
  }

  let [copilot] = await db
    .select()
    .from(copilots)
    .where(eq(copilots.userId, user.id))
    .limit(1);

  if (!copilot) {
    [copilot] = await db
      .insert(copilots)
      .values({
        userId: user.id,
        name: "Integration test copilot",
        status: "active",
        sendLimit: 5,
        emailProfileId: emailProfile.id,
        scrapeProfileId: scrapeProfile.id,
        templateId: template.id,
      })
      .returning();
    console.log("✅ Created copilot", copilot.id);
  } else {
    [copilot] = await db
      .update(copilots)
      .set({
        emailProfileId: emailProfile.id,
        scrapeProfileId: scrapeProfile.id,
        templateId: template.id,
        sendLimit: 5,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(copilots.id, copilot.id))
      .returning();
  }

  return { user, scrapeProfile, emailProfile, template, copilot, testAccount };
}

async function testScraping(scrapeProfile: typeof scrapeProfiles.$inferSelect) {
  console.log("\n─── SCRAPE TEST ───");
  console.log(`Query: "${SEARCH_QUERY}", limit: ${SCRAPE_LIMIT}`);

  const job = await runScrapeJob(scrapeProfile, undefined, SCRAPE_LIMIT);

  const profileLeads = await db
    .select()
    .from(leads)
    .where(eq(leads.scrapeProfileId, scrapeProfile.id))
    .orderBy(desc(leads.id));

  const withEmail = profileLeads.filter((l) => l.status === "new" && isWebsiteScrapedLead(l));
  const scrapedWithEmail = profileLeads.filter(isWebsiteScrapedLead);
  const pending = profileLeads.filter((l) => l.status === "pending_email");
  const failed = profileLeads.filter((l) => l.status === "failed");

  console.log(`Job status: ${job.status}, leadsFound (new emails): ${job.leadsFound}`);
  console.log(`Leads in DB: ${profileLeads.length} total, ${withEmail.length} ready, ${pending.length} pending, ${failed.length} failed, ${scrapedWithEmail.length} with website email`);

  if (profileLeads.length === 0) {
    throw new Error("Scrape test failed: no leads saved");
  }

  console.log("✅ Scrape test passed (at least one lead saved)");
  return { job, withEmail, profileLeads, scrapedWithEmail };
}

async function testSmtp(emailProfile: typeof emailProfiles.$inferSelect) {
  console.log("\n─── SMTP TEST ───");
  const result = await testSmtpConnection({
    host: emailProfile.smtpHost!,
    port: emailProfile.smtpPort ?? 587,
    email: emailProfile.email,
    pass: emailProfile.smtpPass!,
    sendName: emailProfile.sendName ?? emailProfile.email,
  });

  if (!result.success) {
    throw new Error(`SMTP test failed: ${result.error}`);
  }
  console.log("✅ SMTP connection verified");
}

function isWebsiteScrapedLead(lead: typeof leads.$inferSelect) {
  return Boolean(lead.email) && !lead.companyName.startsWith("Synthetic Test Co");
}

async function getWebsiteLeadForSend(scrapeProfileId: number) {
  const profileLeads = await db
    .select()
    .from(leads)
    .where(eq(leads.scrapeProfileId, scrapeProfileId))
    .orderBy(desc(leads.id));

  const scraped = profileLeads.filter(isWebsiteScrapedLead);

  if (scraped.length === 0) {
    throw new Error(
      "Email send test failed: no lead with a website email found. Scrape must extract an email from a business website first."
    );
  }

  let lead = scraped.find((l) => l.status === "new") ?? scraped[0];

  if (lead.status !== "new") {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    await db
      .delete(emailLogs)
      .where(
        and(
          eq(emailLogs.leadId, lead.id),
          eq(emailLogs.status, "sent"),
          gte(emailLogs.sentAt, startOfDay)
        )
      );

    [lead] = await db
      .update(leads)
      .set({ status: "new", emailedAt: null, updatedAt: new Date() })
      .where(eq(leads.id, lead.id))
      .returning();

    console.log(`ℹ️  Reusing scraped lead for send test: "${lead.companyName}" <${lead.email}>`);
  } else {
    console.log(`ℹ️  Sending to website email: "${lead.companyName}" <${lead.email}>`);
  }

  return lead;
}

async function testEmailSending(
  copilot: typeof copilots.$inferSelect,
  scrapeProfileId: number,
  withEmail: (typeof leads.$inferSelect)[]
) {
  console.log("\n─── EMAIL SEND TEST ───");

  if (withEmail.length === 0) {
    await getWebsiteLeadForSend(scrapeProfileId);
  } else {
    const lead = withEmail[0];
    console.log(`ℹ️  Sending to website email: "${lead.companyName}" <${lead.email}>`);
  }

  const beforeLogs = await db.select().from(emailLogs);
  await sendPendingLeads(copilot.id);
  const afterLogs = await db.select().from(emailLogs).orderBy(desc(emailLogs.id));

  const newLogs = afterLogs.slice(0, afterLogs.length - beforeLogs.length);
  const sent = newLogs.filter((l) => l.status === "sent");

  if (sent.length === 0) {
    const failed = newLogs.filter((l) => l.status === "failed");
    throw new Error(
      `Email send test failed: no emails sent${failed[0]?.errorMessage ? ` (${failed[0].errorMessage})` : ""}`
    );
  }

  const previewUrl = nodemailer.getTestMessageUrl(
    sent[0] as unknown as nodemailer.SentMessageInfo
  );
  console.log(`✅ Email send test passed — ${sent.length} email(s) sent`);
  const [sentLead] = await db
    .select({ companyName: leads.companyName, email: leads.email })
    .from(leads)
    .where(eq(leads.id, sent[0].leadId));
  if (sentLead?.email) {
    console.log(`   Recipient (website email): ${sentLead.email} (${sentLead.companyName})`);
  }
  if (previewUrl) {
    console.log(`   Preview: ${previewUrl}`);
  }
}

async function main() {
  console.log("🧪 Email Copilot integration test\n");

  const data = await ensureTestData();
  await testSmtp(data.emailProfile);
  const { withEmail } = await testScraping(data.scrapeProfile);
  await testEmailSending(data.copilot, data.scrapeProfile.id, withEmail);

  console.log("\n🎉 All tests passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
