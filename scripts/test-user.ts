/**
 * Seed test users with all records needed to use the app (subscription, profiles, copilot).
 * Run: pnpm exec tsx scripts/test-user.ts
 */
import "dotenv/config";
import nodemailer from "nodemailer";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/drizzle";
import {
  users,
  emailProfiles,
  emailTemplates,
  scrapeProfiles,
  copilots,
  subscriptions,
  usage,
} from "../src/db/schema";

type TestUserConfig = {
  clerkId: string;
  email: string;
  firstName: string;
  lastName: string;
  timezone: string;
  theme: "light" | "dark";
  notifyOnReply: boolean;
  notifyOnBounce: boolean;
  notifyWeeklyReport: boolean;
  searchQuery: string;
  planId: string;
  copilotName: string;
};

const TEST_USERS: TestUserConfig[] = [
  {
    clerkId: "test_clerk_user_1",
    email: "test1@test.com",
    firstName: "Alice",
    lastName: "Tester",
    timezone: "Europe/Amsterdam",
    theme: "light",
    notifyOnReply: true,
    notifyOnBounce: true,
    notifyWeeklyReport: false,
    searchQuery: "coffee shop Amsterdam",
    planId: "starter",
    copilotName: "Amsterdam Coffee Copilot",
  },
  {
    clerkId: "test_clerk_user_2",
    email: "test2@test.com",
    firstName: "Bob",
    lastName: "Tester",
    timezone: "America/New_York",
    theme: "dark",
    notifyOnReply: true,
    notifyOnBounce: false,
    notifyWeeklyReport: true,
    searchQuery: "restaurant New York",
    planId: "starter",
    copilotName: "NYC Restaurant Copilot",
  },
  {
    clerkId: "test_clerk_user_3",
    email: "test3@test.com",
    firstName: "Carol",
    lastName: "Tester",
    timezone: "Europe/London",
    theme: "light",
    notifyOnReply: false,
    notifyOnBounce: true,
    notifyWeeklyReport: false,
    searchQuery: "dentist London",
    planId: "starter",
    copilotName: "London Dentist Copilot",
  },
];

function currentBillingPeriod() {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23,
    59,
    59,
  );
  return { periodStart, periodEnd };
}

async function resolveSmtpCreds(): Promise<{
  email: string;
  pass: string;
  host: string;
  port: number;
}> {
  const testAccount = await nodemailer.createTestAccount();
  return {
    email: testAccount.user,
    pass: testAccount.pass,
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
  };
}

async function ensureTestUser(config: TestUserConfig) {
  console.log(`\n─── ${config.email} ───`);

  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, config.email));

  const { searchQuery, planId, copilotName, ...userFields } = config;

  if (!user) {
    [user] = await db.insert(users).values(userFields).returning();
    console.log("✅ Created user", user.id);
  } else {
    console.log("ℹ️  Using existing user", user.id);
  }

  const { periodStart, periodEnd } = currentBillingPeriod();

  let [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id))
    .limit(1);

  if (!subscription) {
    [subscription] = await db
      .insert(subscriptions)
      .values({
        userId: user.id,
        planId,
        status: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      })
      .returning();
    console.log("✅ Created subscription", subscription.id, `(${planId})`);
  } else {
    console.log("ℹ️  Using existing subscription", subscription.id);
  }

  let [usageRow] = await db
    .select()
    .from(usage)
    .where(eq(usage.userId, user.id))
    .limit(1);

  if (!usageRow) {
    [usageRow] = await db
      .insert(usage)
      .values({
        userId: user.id,
        subscriptionId: subscription.id,
        periodStart,
        periodEnd,
      })
      .returning();
    console.log("✅ Created usage record", usageRow.id);
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
        name: `${config.firstName} scrape profile`,
        searchQuery,
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

  let smtp: { email: string; pass: string; host: string; port: number };

  if (!emailProfile) {
    smtp = await resolveSmtpCreds();
    console.log("✅ Ethereal SMTP account:", smtp.email);

    [emailProfile] = await db
      .insert(emailProfiles)
      .values({
        userId: user.id,
        profileName: "Test SMTP",
        email: smtp.email,
        sendName: `${config.firstName} ${config.lastName}`,
        provider: "smtp",
        smtpHost: smtp.host,
        smtpPort: smtp.port,
        smtpPass: smtp.pass,
        status: "active",
        lastVerifiedAt: new Date(),
      })
      .returning();
    console.log("✅ Created email profile", emailProfile.id);
  } else {
    smtp = {
      email: emailProfile.email,
      pass: emailProfile.smtpPass ?? "",
      host: emailProfile.smtpHost ?? "",
      port: emailProfile.smtpPort ?? 587,
    };
    console.log("ℹ️  Using existing email profile", emailProfile.id);
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
        name: "Default Outreach Template",
        subject: "Quick question about {{companyName}}",
        body: `Hi,\n\nI came across {{companyName}} and wanted to reach out.\n\nBest,\n{{senderName}}`,
        category: "Cold Outreach",
        variables: ["companyName", "senderName"],
      })
      .returning();
    console.log("✅ Created email template", template.id);
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
        name: copilotName,
        description: `Seeded copilot for ${config.email}`,
        status: "running",
        sendLimit: 10,
        emailProfileId: emailProfile!.id,
        scrapeProfileId: scrapeProfile!.id,
        templateId: template!.id,
        settings: { schedule: { runAt: "09:00" } },
      })
      .returning();
    console.log("✅ Created copilot", copilot.id);
  } else {
    [copilot] = await db
      .update(copilots)
      .set({
        emailProfileId: emailProfile!.id,
        scrapeProfileId: scrapeProfile!.id,
        templateId: template!.id,
        status: "active",
        settings: { schedule: { runAt: "09:00" } },
        updatedAt: new Date(),
      })
      .where(eq(copilots.id, copilot.id))
      .returning();
    console.log("ℹ️  Updated copilot links", copilot.id);
  }

  return {
    user,
    subscription,
    usage: usageRow,
    scrapeProfile,
    emailProfile,
    template,
    copilot,
    smtp: { email: smtp.email, host: smtp.host, port: smtp.port },
  };
}

async function truncateAllTables() {
  await db.execute(sql`TRUNCATE TABLE users CASCADE`);
  await db.execute(sql`TRUNCATE TABLE email_profiles CASCADE`);
  await db.execute(sql`TRUNCATE TABLE email_templates CASCADE`);
  await db.execute(sql`TRUNCATE TABLE scrape_profiles CASCADE`);
  await db.execute(sql`TRUNCATE TABLE copilots CASCADE`);
  await db.execute(sql`TRUNCATE TABLE subscriptions CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage CASCADE`);
  await db.execute(sql`TRUNCATE TABLE scrape_jobs CASCADE`);
  await db.execute(sql`TRUNCATE TABLE copilot_leads CASCADE`);
  await db.execute(sql`TRUNCATE TABLE leads2 CASCADE`);
  await db.execute(sql`TRUNCATE TABLE email_logs CASCADE`);
}

async function main() {
  console.log(`🌱 Seeding ${TEST_USERS.length} test users`);
  await truncateAllTables();

  const results: Awaited<ReturnType<typeof ensureTestUser>>[] = [];
  for (const config of TEST_USERS) {
    results.push(await ensureTestUser(config));
  }

  console.log("\n─── Summary ───");
  for (const data of results) {
    console.log(
      `${data.user.email}: id=${data.user.id}, clerkId=${data.user.clerkId}, scrape="${data.scrapeProfile.searchQuery}", copilot="${data.copilot.name}"`,
    );
  }
  console.log(`\n🎉 ${results.length} test users ready`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
