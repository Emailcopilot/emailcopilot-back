import "dotenv/config";
import pg from "pg";
import { db } from "../src/db/drizzle";
import {
  copilots,
  emailProfiles,
  emailTemplates,
  scrapeProfiles,
  subscriptions,
  users,
} from "../src/db/schema";

const neonDB = new pg.Pool({
  connectionString: process.env.NEON_DATABASE_URL,
});

const migrateSubscriptions = async () => {
  const res = await neonDB.query("SELECT * FROM subscriptions");
  const subscriptionsData = res.rows;

  for (const subscription of subscriptionsData) {
    const data = {
      id: subscription.id,
      userId: subscription.user_id,
      planId: subscription.plan_id,
      status: subscription.status,
      mollieCustomerId: subscription.mollie_customer_id,
      mollieSubscriptionId: subscription.mollie_subscription_id,
    };

    await db
      .insert(subscriptions)
      .values(data)
      .onConflictDoUpdate({
        target: [subscriptions.id],
        set: data,
      });
  }
};

const migrateUsers = async () => {
  const res = await neonDB.query("SELECT * FROM users");
  const usersData = res.rows;

  for (const user of usersData) {
    const data = {
      id: user.id,
      email: user.email,
      password: user.password,
      name: user.name,
      clerkId: user.clerk_id,
      theme: user.theme,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    };

    await db
      .insert(users)
      .values(data)
      .onConflictDoUpdate({
        target: [users.id],
        set: data,
      });
  }
};

const migrateEmailProfiles = async () => {
  const res = await neonDB.query("SELECT * FROM email_profiles");
  const emailProfilesData = res.rows;

  for (const emailProfile of emailProfilesData) {
    const data = {
      id: emailProfile.id,
      userId: emailProfile.user_id,
      profileName: emailProfile.profile_name,
      email: emailProfile.email,
      sendName: emailProfile.send_name,
      provider: emailProfile.provider,
      smtpHost: emailProfile.smtp_host,
      smtpPort: emailProfile.smtp_port,
      smtpPass: emailProfile.smtp_pass,
      status: emailProfile.status,
      sentToday: emailProfile.sent_today,
      lastVerifiedAt: emailProfile.last_verified_at,
      createdAt: emailProfile.created_at,
      updatedAt: emailProfile.updated_at,
    };

    await db
      .insert(emailProfiles)
      .values(data)
      .onConflictDoUpdate({
        target: [emailProfiles.id],
        set: data,
      });
  }
};

const migrateScrapeProfiles = async () => {
  const res = await neonDB.query("SELECT * FROM scrape_profiles");
  const scrapeProfilesData = res.rows;

  for (const data of scrapeProfilesData) {
    const scrapeProfileData = {
      id: data.id,
      userId: data.user_id,
      name: data.name,
      searchQuery: data.search_query,
      status: data.status,
      resultsCount: data.results_count,
      lastRun: data.last_run,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };

    await db
      .insert(scrapeProfiles)
      .values(scrapeProfileData)
      .onConflictDoUpdate({
        target: [scrapeProfiles.id],
        set: scrapeProfileData,
      });
  }
};

const migrateEmailTemplates = async () => {
  const res = await neonDB.query("SELECT * FROM email_templates");
  const emailTemplatesData = res.rows;

  for (const data of emailTemplatesData) {
    const emailTemplateData = {
      id: data.id,
      userId: data.user_id,
      name: data.name,
      subject: data.subject,
      body: data.body,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };

    await db
      .insert(emailTemplates)
      .values(emailTemplateData)
      .onConflictDoUpdate({
        target: [emailTemplates.id],
        set: emailTemplateData,
      });
  }
};

const migrateCopilots = async () => {
  const res = await neonDB.query("SELECT * FROM copilots");
  const copilotsData = res.rows;

  for (const data of copilotsData) {
    const copilotData = {
      id: data.id,
      userId: data.user_id,
      name: data.name,
      description: data.description,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };

    await db
      .insert(copilots)
      .values(copilotData)
      .onConflictDoUpdate({
        target: [copilots.id],
        set: copilotData,
      });
  }
};

const migrate = async () => {
  try {
    await Promise.all([
      migrateUsers(),
      migrateSubscriptions(),
      migrateEmailProfiles(),
      migrateScrapeProfiles(),
      migrateEmailTemplates(),
      migrateCopilots(),
    ]);
    console.log("✅ Migration completed successfully");
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
};

migrate();
