/**
 * seed.ts — run with: npx tsx db/seed.ts
 *
 * Populates the database with realistic sample data for development.
 * Requires DATABASE_URL in env (e.g. postgresql://user:pass@localhost:5432/emailcopilot)
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

async function seed() {
  console.log("🌱 Seeding database...\n");

  // Clean up existing data first
  console.log("🧹 Cleaning up existing data...");
  await db.delete(schema.invoices);
  await db.delete(schema.subscriptions);
  await db.delete(schema.emailLogs);
  await db.delete(schema.integrations);
  await db.delete(schema.leads);
  await db.delete(schema.scrapeJobs);
  await db.delete(schema.copilots);
  await db.delete(schema.emailTemplates);
  await db.delete(schema.emailProfiles);
  await db.delete(schema.scrapeResults);
  await db.delete(schema.scrapeProfiles);
  await db.delete(schema.settings);
  await db.delete(schema.users);
  console.log("✅ Cleanup complete\n");

  // ── Users ──────────────────────────────────────────────────────────────────
  const [user] = await db
    .insert(schema.users)
    .values({
      clerkId: "clerk_user_123",
      firstName: "Alex",
      lastName: "Martin",
      email: "alex@example.com",
      timezone: "America/New_York",
      theme: "light",
      notifyOnReply: true,
      notifyOnBounce: true,
      notifyWeeklyReport: true,
    })
    .returning();

  console.log(`✅ Created user: ${user.email} (id=${user.id})`);

  // ── Email Profiles ─────────────────────────────────────────────────────────
  const [ep1, ep2] = await db
    .insert(schema.emailProfiles)
    .values([
      {
        userId: user.id,
        name: "Primary Outreach",
        email: "outreach@example.com",
        provider: "gmail",
        status: "active",
        dailyLimit: 150,
        sentToday: 47,
      },
      {
        userId: user.id,
        name: "Secondary Gmail",
        email: "backup@example.com",
        provider: "gmail",
        status: "active",
        dailyLimit: 100,
        sentToday: 12,
      },
      {
        userId: user.id,
        name: "Sendgrid SMTP",
        email: "noreply@example.com",
        provider: "smtp",
        smtpHost: "smtp.sendgrid.net",
        smtpPort: 587,
        username: "apikey",
        status: "inactive",
        dailyLimit: 500,
        sentToday: 0,
      },
    ])
    .returning();

  console.log(`✅ Created ${3} email profiles`);

  // ── Scrape Profiles ────────────────────────────────────────────────────────
  const [sp1] = await db
    .insert(schema.scrapeProfiles)
    .values([
      {
        userId: user.id,
        name: "LinkedIn Tech Founders",
        searchQuery: "site:linkedin.com/in/ AND (\"founder\" OR \"ceo\") AND (\"tech\" OR \"software\")",
        resultsPerRun: 50,
        schedule: "0 9 * * 1",
        status: "done",
        resultsCount: 342,
        lastRun: new Date("2025-04-28"),
      },
      {
        userId: user.id,
        name: "Crunchbase Seed Startups",
        searchQuery: "site:crunchbase.com/ AND (\"seed\" OR \"pre-seed\") AND (\"tech\" OR \"software\")",
        resultsPerRun: 50,
        schedule: "0 9 * * 1",
        status: "idle",
        resultsCount: 0,
        lastRun: null,
      },
    ])
    .returning();

  console.log(`✅ Created ${2} scrape profiles`);

  // ── Templates ──────────────────────────────────────────────────────────────
  const [t1, t2, t3] = await db
    .insert(schema.emailTemplates)
    .values([
      {
        userId: user.id,
        name: "Cold Intro — SaaS Founders",
        subject: "Quick question about {{company}}",
        body: `Hi {{firstName}},

I came across {{company}} and was impressed by what you're building in the {{industry}} space.

We help companies like yours automate personalized email outreach — typically cutting the time spent on prospecting by 70%.

Would it make sense to hop on a 15-minute call this week?

Best,
{{senderName}}`,
        category: "Cold Outreach",
        variables: ["firstName", "company", "industry", "senderName"],
        usageCount: 24,
      },
      {
        userId: user.id,
        name: "Follow-up #1 (3 days)",
        subject: "Re: Quick question about {{company}}",
        body: `Hi {{firstName}},

Just wanted to follow up on my previous email in case it got buried.

I know your inbox is probably slammed — I'll keep this short. We've helped {{similarCompany}} increase reply rates by 3x in the first month.

Worth a quick chat?

{{senderName}}`,
        category: "Follow-up",
        variables: ["firstName", "company", "similarCompany", "senderName"],
        usageCount: 18,
      },
      {
        userId: user.id,
        name: "Re-engagement — 90 Days",
        subject: "Checking back in, {{firstName}}",
        body: `Hi {{firstName}},

It's been a while since we last spoke. A lot has changed at {{senderCompany}} since then — we've launched new features that I think would be a great fit for {{company}}.

Open to reconnecting?

{{senderName}}`,
        category: "Re-engagement",
        variables: ["firstName", "company", "senderCompany", "senderName"],
        usageCount: 6,
      },
      {
        userId: user.id,
        name: "Partnership Outreach",
        subject: "Partnership idea for {{company}} × {{senderCompany}}",
        body: `Hi {{firstName}},

I've been following {{company}}'s work and I think there's a compelling partnership opportunity between our two teams.

We serve similar audiences and I'd love to explore co-marketing or a referral arrangement.

Would you be open to a 20-min intro call?

{{senderName}}`,
        category: "Partnership",
        variables: ["firstName", "company", "senderCompany", "senderName"],
        usageCount: 3,
      },
    ])
    .returning();

  console.log(`✅ Created ${4} templates`);

  // ── Copilots ───────────────────────────────────────────────────────────────
  await db.insert(schema.copilots).values([
    {
      userId: user.id,
      name: "SaaS Founder Blitz",
      description: "Cold outreach targeting early-stage SaaS founders from Crunchbase.",
      status: "active",
      emailProfileId: ep1.id,
      scrapeProfileId: sp1.id,
      templateId: t1.id,
      settings: { sendTimeStart: "09:00", sendTimeEnd: "17:00", delayMinutes: 90 },
      emailsSent: 312,
      emailsOpened: 148,
      emailsReplied: 21,
    },
    {
      userId: user.id,
      name: "LinkedIn Warm-Up",
      description: "Gentle outreach to LinkedIn connections.",
      status: "paused",
      emailProfileId: ep2.id,
      scrapeProfileId: sp1.id,
      templateId: t2.id,
      settings: { sendTimeStart: "10:00", sendTimeEnd: "16:00", delayMinutes: 120 },
      emailsSent: 54,
      emailsOpened: 30,
      emailsReplied: 4,
    },
    {
      userId: user.id,
      name: "Re-engagement Campaign",
      description: "Win back cold leads from 90+ days ago.",
      status: "draft",
      emailProfileId: null,
      scrapeProfileId: null,
      templateId: t3.id,
      settings: {},
      emailsSent: 0,
      emailsOpened: 0,
      emailsReplied: 0,
    },
  ]);

  console.log(`✅ Created ${3} copilots`);

  // ── Integrations ───────────────────────────────────────────────────────────
  await db.insert(schema.integrations).values([
    {
      userId: user.id,
      provider: "google",
      accessToken: "ya29.example_token",
      refreshToken: "1//example_refresh",
      expiresAt: new Date(Date.now() + 3600 * 1000),
      connectedAt: new Date("2025-03-10"),
    },
    {
      userId: user.id,
      provider: "slack",
      accessToken: "xoxb-example-slack-token",
      connectedAt: new Date("2025-04-01"),
    },
    {
      userId: user.id,
      provider: "hunter",
      apiKey: "hunter_api_key_example",
      connectedAt: new Date("2025-04-15"),
    },
  ]);

  console.log(`✅ Created ${3} integrations`);

  // ── Subscriptions & Invoices ───────────────────────────────────────────────
  const [sub] = await db
    .insert(schema.subscriptions)
    .values({
      userId: user.id,
      planId: "pro",
      status: "active",
      stripeSubscriptionId: "sub_example123",
      stripeCustomerId: "cus_example123",
      currentPeriodStart: new Date("2025-05-01"),
      currentPeriodEnd: new Date("2025-06-01"),
      cancelAtPeriodEnd: false,
    })
    .returning();

  await db.insert(schema.invoices).values([
    {
      userId: user.id,
      subscriptionId: sub.id,
      stripeInvoiceId: "in_example_apr",
      amount: 7900,
      currency: "usd",
      status: "paid",
      downloadUrl: "https://pay.stripe.com/invoice/example_apr",
      paidAt: new Date("2025-04-01"),
    },
    {
      userId: user.id,
      subscriptionId: sub.id,
      stripeInvoiceId: "in_example_mar",
      amount: 7900,
      currency: "usd",
      status: "paid",
      downloadUrl: "https://pay.stripe.com/invoice/example_mar",
      paidAt: new Date("2025-03-01"),
    },
    {
      userId: user.id,
      subscriptionId: sub.id,
      stripeInvoiceId: "in_example_feb",
      amount: 2900,
      currency: "usd",
      status: "paid",
      downloadUrl: "https://pay.stripe.com/invoice/example_feb",
      paidAt: new Date("2025-02-01"),
    },
  ]);

  console.log(`✅ Created subscription (Pro) + ${3} invoices`);

  console.log("\n🎉 Seed complete!");
  await pool.end();
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
