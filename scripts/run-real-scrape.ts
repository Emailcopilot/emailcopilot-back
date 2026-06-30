/**
 * Fresh Google Maps scrape, extract website emails, then send outreach emails.
 *
 * Usage: pnpm exec tsx scripts/run-real-scrape.ts [keywords] [scrapeLimit] [sendLimit]
 *        pnpm exec tsx scripts/run-real-scrape.ts --no-send [keywords] [scrapeLimit]
 *
 * Examples:
 *   pnpm exec tsx scripts/run-real-scrape.ts "coffee shop Amsterdam" 10
 *   pnpm exec tsx scripts/run-real-scrape.ts "coffee shop Amsterdam" 10 3
 *   pnpm exec tsx scripts/run-real-scrape.ts --no-send "plumbers Rotterdam" 5
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
import { eq, desc, and } from "drizzle-orm";
import { runScrapeJob } from "../src/services/scraper.service";
import { sendPendingLeads, testSmtpConnection } from "../src/services/mailer.service";

const TEST_USER_EMAIL = "integration-test@emailcopilot.local";

const args = process.argv.slice(2);
const SKIP_SEND = args.includes("--no-send");
const positional = args.filter((a) => !a.startsWith("--"));

const SEARCH_QUERY = positional[0] ?? "coffee shop Amsterdam";
const SCRAPE_LIMIT = Math.min(Math.max(parseInt(positional[1] ?? "10", 10) || 10, 1), 50);
const SEND_LIMIT_ARG = positional[2] ? parseInt(positional[2], 10) : undefined;

type SmtpTestAccount = { user: string; pass: string; smtp: { host: string; port: number } };

async function resolveSmtpAccount(
  emailProfile: typeof emailProfiles.$inferSelect | undefined
): Promise<{ account: SmtpTestAccount; reused: boolean }> {
  if (emailProfile?.smtpHost && emailProfile.email && emailProfile.smtpPass) {
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

async function ensureUser() {
  let [user] = await db.select().from(users).where(eq(users.email, TEST_USER_EMAIL));

  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        clerkId: "test_clerk_integration",
        email: TEST_USER_EMAIL,
        firstName: "Integration",
        lastName: "Test",
      })
      .returning();
    console.log("✅ Created test user", user.id);
  }

  return user;
}

async function ensureCopilot(
  user: typeof users.$inferSelect,
  profile: typeof scrapeProfiles.$inferSelect,
  sendLimit: number
) {
  let [emailProfile] = await db
    .select()
    .from(emailProfiles)
    .where(eq(emailProfiles.userId, user.id))
    .limit(1);

  const { account, reused } = await resolveSmtpAccount(emailProfile);

  if (!emailProfile) {
    [emailProfile] = await db
      .insert(emailProfiles)
      .values({
        userId: user.id,
        profileName: "Ethereal test",
        email: account.user,
        sendName: "Email Copilot Test",
        provider: "smtp",
        smtpHost: account.smtp.host,
        smtpPort: account.smtp.port,
        smtpPass: account.pass,
        status: "active",
      })
      .returning();
  } else if (!reused) {
    [emailProfile] = await db
      .update(emailProfiles)
      .set({
        email: account.user,
        smtpHost: account.smtp.host,
        smtpPort: account.smtp.port,
        smtpPass: account.pass,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(emailProfiles.id, emailProfile.id))
      .returning();
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
        name: "Outreach template",
        subject: "Quick question about {{companyName}}",
        body: `Hi,\n\nI came across {{companyName}} and wanted to reach out.\n\nBest,\n{{senderName}}`,
        category: "Cold Outreach",
        variables: ["companyName", "senderName"],
      })
      .returning();
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
        name: "Real scrape copilot",
        status: "active",
        sendLimit,
        emailProfileId: emailProfile.id,
        scrapeProfileId: profile.id,
        templateId: template.id,
      })
      .returning();
  } else {
    [copilot] = await db
      .update(copilots)
      .set({
        emailProfileId: emailProfile.id,
        scrapeProfileId: profile.id,
        templateId: template.id,
        sendLimit,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(copilots.id, copilot.id))
      .returning();
  }

  return copilot;
}

async function sendToScrapedLeads(
  copilot: typeof copilots.$inferSelect,
  profileId: number,
  sendLimit: number
) {
  console.log("\n─── EMAIL SEND ───");

  const readyLeads = await db
    .select()
    .from(leads)
    .where(and(eq(leads.scrapeProfileId, profileId), eq(leads.status, "new")))
    .orderBy(leads.scrapedAt);

  const toSend = readyLeads.filter((l) => l.email).slice(0, sendLimit);

  if (toSend.length === 0) {
    console.log("⚠️  No leads with website emails ready to send.");
    return { sent: 0, failed: 0 };
  }

  console.log(`📬 Sending to ${toSend.length} lead(s) (website emails):`);
  for (const lead of toSend) {
    console.log(`  • ${lead.companyName} <${lead.email}>`);
  }
  console.log("   (2–5 min delay between each send)\n");

  const beforeLogs = await db.select({ id: emailLogs.id }).from(emailLogs);

  await sendPendingLeads(copilot.id);

  const afterLogs = await db
    .select({
      id: emailLogs.id,
      status: emailLogs.status,
      leadId: emailLogs.leadId,
      errorMessage: emailLogs.errorMessage,
    })
    .from(emailLogs)
    .orderBy(desc(emailLogs.id));

  const beforeIds = new Set(beforeLogs.map((l) => l.id));
  const newLogs = afterLogs.filter((l) => !beforeIds.has(l.id));
  const sentLogs = newLogs.filter((l) => l.status === "sent");
  const failedLogs = newLogs.filter((l) => l.status === "failed");

  if (sentLogs.length > 0) {
    console.log("\n✅ Sent:");
    for (const log of sentLogs) {
      const lead = toSend.find((l) => l.id === log.leadId);
      console.log(`  • ${lead?.companyName ?? `lead #${log.leadId}`} <${lead?.email ?? "?"}>`);
    }
  }

  if (failedLogs.length > 0) {
    console.log("\n❌ Failed:");
    for (const log of failedLogs) {
      const lead = toSend.find((l) => l.id === log.leadId);
      console.log(
        `  • ${lead?.companyName ?? `lead #${log.leadId}`}: ${log.errorMessage ?? "unknown error"}`
      );
    }
  }

  return { sent: sentLogs.length, failed: failedLogs.length };
}

async function main() {
  console.log(`🔍 Real scrape — keywords: "${SEARCH_QUERY}", limit: ${SCRAPE_LIMIT}`);
  if (SKIP_SEND) console.log("   (--no-send: scrape only)\n");
  else console.log();

  const user = await ensureUser();

  let [profile] = await db
    .select()
    .from(scrapeProfiles)
    .where(eq(scrapeProfiles.userId, user.id))
    .limit(1);

  if (!profile) {
    [profile] = await db
      .insert(scrapeProfiles)
      .values({
        userId: user.id,
        name: "Real scrape",
        searchQuery: SEARCH_QUERY,
        status: "idle",
      })
      .returning();
  } else {
    [profile] = await db
      .update(scrapeProfiles)
      .set({ searchQuery: SEARCH_QUERY, updatedAt: new Date() })
      .where(eq(scrapeProfiles.id, profile.id))
      .returning();
  }

  const deleted = await db
    .delete(leads)
    .where(eq(leads.scrapeProfileId, profile.id))
    .returning({ id: leads.id });
  console.log(`🗑️  Cleared ${deleted.length} old lead(s) for profile ${profile.id}\n`);

  const sendLimit = SEND_LIMIT_ARG ?? SCRAPE_LIMIT;
  const copilot = await ensureCopilot(user, profile, sendLimit);

  const job = await runScrapeJob(profile, SEARCH_QUERY, SCRAPE_LIMIT);

  const results = await db
    .select()
    .from(leads)
    .where(eq(leads.scrapeProfileId, profile.id))
    .orderBy(desc(leads.id));

  const withEmail = results.filter((l) => l.email && l.status === "new");
  const failed = results.filter((l) => l.status === "failed");
  const pending = results.filter((l) => l.status === "pending_email");

  console.log("\n─── SCRAPE RESULTS ───");
  console.log(`Job #${job.id} | listings: ${results.length} | website emails: ${withEmail.length} | failed: ${failed.length} | pending: ${pending.length}\n`);

  if (withEmail.length > 0) {
    console.log("📧 Emails found on websites:");
    for (const lead of withEmail) {
      console.log(`  • ${lead.companyName}`);
      console.log(`    email:   ${lead.email}`);
      console.log(`    website: ${lead.website ?? "—"}`);
    }
  } else {
    console.log("⚠️  No emails extracted from websites this run.");
  }

  if (failed.length > 0) {
    console.log("\n❌ No email found:");
    for (const lead of failed) {
      console.log(`  • ${lead.companyName} — ${lead.website ?? "no website"}`);
    }
  }

  if (SKIP_SEND) {
    process.exit(withEmail.length > 0 ? 0 : 1);
  }

  if (withEmail.length === 0) {
    process.exit(1);
  }

  const effectiveSendLimit = Math.min(sendLimit, withEmail.length);
  await db
    .update(copilots)
    .set({ sendLimit: effectiveSendLimit, updatedAt: new Date() })
    .where(eq(copilots.id, copilot.id));

  const { sent, failed: sendFailed } = await sendToScrapedLeads(
    copilot,
    profile.id,
    effectiveSendLimit
  );

  console.log(`\n📊 Summary: ${withEmail.length} emails scraped, ${sent} sent, ${sendFailed} failed`);
  process.exit(sent > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ Run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
