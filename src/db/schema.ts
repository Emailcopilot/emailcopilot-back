import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  pgEnum,
  jsonb,
} from "drizzle-orm/pg-core";

// ─── Enums ───────────────────────────────────────────────────────────────────

export const emailProviderEnum = pgEnum("email_provider", ["gmail", "outlook", "smtp"]);
export const emailProfileStatusEnum = pgEnum("email_profile_status", ["active", "inactive", "error"]);

export const scrapeStatusEnum = pgEnum("scrape_status", ["idle", "running", "done", "error"]);
export const scrapeJobStatusEnum = pgEnum("scrape_job_status", ["running", "done", "failed"]);

export const templateCategoryEnum = pgEnum("template_category", [
  "Cold Outreach",
  "Follow-up",
  "Re-engagement",
  "Partnership",
  "Other",
]);

export const copilotStatusEnum = pgEnum("copilot_status", ["draft", "active", "paused", "archived"]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "canceled",
  "past_due",
  "trialing",
  "pending",
  "suspended",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", ["paid", "pending", "failed"]);

export const themeEnum = pgEnum("theme", ["light", "dark", "system"]);

// ✅ Added "replied" and "disqualified" — were used in lead.service but missing from the enum
export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "queued",
  "sent",
  "failed",
  "replied",
  "disqualified",
  "unsubscribed",
]);

export const emailLogStatusEnum = pgEnum("email_log_status", ["sent", "failed", "opened", "replied"]);

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkId: varchar("clerk_id", { length: 255 }).notNull().unique(),
  firstName: varchar("first_name", { length: 100 }).default(""),
  lastName: varchar("last_name", { length: 100 }).default(""),
  email: varchar("email", { length: 255 }).notNull().unique(),
  timezone: varchar("timezone", { length: 100 }).notNull().default("UTC"),
  theme: themeEnum("theme").notNull().default("light"),
  notifyOnReply: boolean("notify_on_reply").notNull().default(true),
  notifyOnBounce: boolean("notify_on_bounce").notNull().default(true),
  notifyWeeklyReport: boolean("notify_weekly_report").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Email Profiles ───────────────────────────────────────────────────────────

export const emailProfiles = pgTable("email_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  provider: emailProviderEnum("provider").notNull().default("smtp"),
  smtpHost: varchar("smtp_host", { length: 255 }),
  smtpPort: integer("smtp_port").default(587),
  smtpUser: varchar("smtp_user", { length: 255 }),
  smtpPass: text("smtp_pass"), // store encrypted in practice
  status: emailProfileStatusEnum("status").notNull().default("inactive"),
  dailyLimit: integer("daily_limit").notNull().default(100),
  sentToday: integer("sent_today").notNull().default(0),
  lastVerifiedAt: timestamp("last_verified_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Email Templates ──────────────────────────────────────────────────────────

export const emailTemplates = pgTable("email_templates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 150 }).notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  category: templateCategoryEnum("category").notNull().default("Other"),
  isActive: boolean("is_active").notNull().default(false),
  variables: jsonb("variables").$type<string[]>().notNull().default([]),
  usageCount: integer("usage_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Scrape Profiles ──────────────────────────────────────────────────────────
// User-facing config: what to search, how many results, on what schedule.
// Each execution creates one scrapeJob row.

export const scrapeProfiles = pgTable("scrape_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  // ✅ Widened from 100 → 500: real search queries ("plumbers in Amsterdam near city centre") easily exceed 100 chars
  searchQuery: varchar("search_query", { length: 500 }).notNull(),
  resultsPerRun: integer("results_per_run").notNull().default(100),
  schedule: varchar("schedule", { length: 100 }), // cron expression
  status: scrapeStatusEnum("status").notNull().default("idle"),
  resultsCount: integer("results_count").notNull().default(0),
  lastRun: timestamp("last_run"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Scrape Jobs ──────────────────────────────────────────────────────────────
// One row per execution. Links back to the profile that triggered it.

export const scrapeJobs = pgTable("scrape_jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "set null" }),
  // ✅ Added: which profile triggered this job (null for ad-hoc calls)
  scrapeProfileId: integer("scrape_profile_id")
    .references(() => scrapeProfiles.id, { onDelete: "set null" }),
  query: text("query").notNull(),
  status: scrapeJobStatusEnum("status").notNull().default("running"),
  leadsFound: integer("leads_found").notNull().default(0),
  errorMessage: text("error_message"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Leads ────────────────────────────────────────────────────────────────────

export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "set null" }),
  companyName: varchar("company_name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  website: text("website").unique(),
  phone: varchar("phone", { length: 50 }),
  address: text("address"),
  sourceQuery: text("source_query"),
  // ✅ Added: direct link to the profile that found this lead (scrapeJobId alone wasn't enough
  //    because you'd need a join to go lead → job → profile)
  scrapeProfileId: integer("scrape_profile_id")
    .references(() => scrapeProfiles.id, { onDelete: "set null" }),
  scrapeJobId: integer("scrape_job_id")
    .references(() => scrapeJobs.id, { onDelete: "set null" }),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
  status: leadStatusEnum("status").notNull().default("new"),
  notes: text("notes"),                // ✅ Added: used by patchLead
  emailedAt: timestamp("emailed_at"),
  repliedAt: timestamp("replied_at"),  // ✅ Added: used by patchLead
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Email Logs ───────────────────────────────────────────────────────────────

export const emailLogs = pgTable("email_logs", {
  id: serial("id").primaryKey(),
  usersId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  leadId: integer("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  templateId: integer("template_id")
    .references(() => emailTemplates.id, { onDelete: "set null" }),
  subject: text("subject").notNull(),
  status: emailLogStatusEnum("status").notNull(),
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
});

// ─── Scrape Results ───────────────────────────────────────────────────────────

export const scrapeResults = pgTable("scrape_results", {
  id: serial("id").primaryKey(),
  scrapeProfileId: integer("scrape_profile_id")
    .notNull()
    .references(() => scrapeProfiles.id, { onDelete: "cascade" }),
  data: jsonb("data").$type<Record<string, string>>().notNull(),
  scrapedAt: timestamp("scraped_at").notNull().defaultNow(),
});

// ─── Copilots ─────────────────────────────────────────────────────────────────

export const copilots = pgTable("copilots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 150 }).notNull(),
  description: text("description"),
  status: copilotStatusEnum("status").notNull().default("draft"),
  emailProfileId: integer("email_profile_id").references(() => emailProfiles.id, {
    onDelete: "set null",
  }),
  scrapeProfileId: integer("scrape_profile_id").references(() => scrapeProfiles.id, {
    onDelete: "set null",
  }),
  templateId: integer("template_id").references(() => emailTemplates.id, {
    onDelete: "set null",
  }),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  emailsSent: integer("emails_sent").notNull().default(0),
  emailsOpened: integer("emails_opened").notNull().default(0),
  emailsReplied: integer("emails_replied").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Billing / Subscriptions ──────────────────────────────────────────────────

export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  planId: varchar("plan_id", { length: 50 }).notNull(),
  status: subscriptionStatusEnum("status").notNull().default("pending"),
  mollieCustomerId: varchar("mollie_customer_id", { length: 255 }),
  mollieSubscriptionId: varchar("mollie_subscription_id", { length: 255 }),
  mollieMandateId: varchar("mollie_mandate_id", { length: 255 }),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  subscriptionId: integer("subscription_id").references(() => subscriptions.id, {
    onDelete: "set null",
  }),
  molliePaymentId: varchar("mollie_payment_id", { length: 255 }),
  amount: integer("amount").notNull(),
  currency: varchar("currency", { length: 10 }).notNull().default("eur"),
  status: invoiceStatusEnum("status").notNull().default("pending"),
  downloadUrl: text("download_url"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const usage = pgTable("usage", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  subscriptionId: integer("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  emailsSent: integer("emails_sent").notNull().default(0),
  copilotsCreated: integer("copilots_created").notNull().default(0),
  emailProfilesCreated: integer("email_profiles_created").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Type exports ─────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type EmailProfile = typeof emailProfiles.$inferSelect;
export type NewEmailProfile = typeof emailProfiles.$inferInsert;

export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type NewEmailTemplate = typeof emailTemplates.$inferInsert;

export type ScrapeProfile = typeof scrapeProfiles.$inferSelect;
export type NewScrapeProfile = typeof scrapeProfiles.$inferInsert;

export type ScrapeJob = typeof scrapeJobs.$inferSelect;
export type NewScrapeJob = typeof scrapeJobs.$inferInsert;

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;

export type EmailLog = typeof emailLogs.$inferSelect;
export type NewEmailLog = typeof emailLogs.$inferInsert;

export type ScrapeResult = typeof scrapeResults.$inferSelect;
export type NewScrapeResult = typeof scrapeResults.$inferInsert;

export type Copilot = typeof copilots.$inferSelect;
export type NewCopilot = typeof copilots.$inferInsert;

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
