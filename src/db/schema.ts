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
import * as d from "drizzle-orm/pg-core";

const defaultColumns = () => {
  return {
    id: d.integer().primaryKey().generatedAlwaysAsIdentity(),
    createdAt: d.timestamp().notNull().defaultNow(),
    updatedAt: d.timestamp().notNull().defaultNow(),
  };
};

// ─── Enums ───────────────────────────────────────────────────────────────────

export const emailProviderEnum = pgEnum("email_provider", [
  "gmail",
  "outlook",
  "smtp",
]);
export const emailProfileStatusEnum = pgEnum("email_profile_status", [
  "active",
  "inactive",
  "error",
]);

export const scrapeStatusEnum = pgEnum("scrape_status", [
  "idle",
  "running",
  "done",
  "error",
]);
export const scrapeJobStatusEnum = pgEnum("scrape_job_status", [
  "running",
  "done",
  "failed",
]);

export const templateCategoryEnum = pgEnum("template_category", [
  "Cold Outreach",
  "Follow-up",
  "Re-engagement",
  "Partnership",
  "Other",
]);

export const copilotStatusEnum = pgEnum("copilot_status", [
  "draft",
  "active",
  "paused",
  "archived",
  "running",
  "completed",
]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "canceled",
  "past_due",
  "trialing",
  "pending",
  "suspended",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "paid",
  "pending",
  "failed",
]);

export const themeEnum = pgEnum("theme", ["light", "dark", "system"]);

// ─── Users ────────────────────────────────────────────────────────────────────

export const usersTable = pgTable("users", {
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

export const emailProfilesTable = pgTable("email_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  profileName: varchar("profile_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  sendName: varchar("send_name", { length: 100 }),
  provider: emailProviderEnum("provider").notNull().default("smtp"),
  smtpHost: varchar("smtp_host", { length: 255 }),
  smtpPort: integer("smtp_port").default(587),
  smtpPass: text("smtp_pass"), // store encrypted in practice
  status: emailProfileStatusEnum("status").notNull().default("inactive"),
  sentToday: integer("sent_today").notNull().default(0),
  lastVerifiedAt: timestamp("last_verified_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Email Templates ──────────────────────────────────────────────────────────

export const emailTemplatesTable = pgTable("email_templates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 150 }).notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  category: templateCategoryEnum("category").notNull().default("Other"),
  variables: jsonb("variables").$type<string[]>().notNull().default([]),
  usageCount: integer("usage_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Scrape Profiles ──────────────────────────────────────────────────────────
// User-facing config: what to search, how many results, on what schedule.
// Each execution creates one scrapeJob row.

export const scrapeProfilesTable = pgTable("scrape_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  searchQuery: varchar("search_query", { length: 500 }).notNull(),
  country: varchar({ length: 100 }),
  city: varchar({ length: 100 }),
  status: scrapeStatusEnum("status").notNull().default("idle"),
  resultsCount: integer("results_count").notNull().default(0),
  lastRun: timestamp("last_run"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Scrape Jobs ──────────────────────────────────────────────────────────────
// One row per execution. Links back to the profile that triggered it.

export const scrapeJobsTable = pgTable("scrape_jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  // ✅ Added: which profile triggered this job (null for ad-hoc calls)
  scrapeProfileId: integer("scrape_profile_id").references(
    () => scrapeProfilesTable.id,
    { onDelete: "set null" },
  ),
  query: text("query").notNull(),
  status: scrapeJobStatusEnum("status").notNull().default("running"),
  leadsFound: integer("leads_found").notNull().default(0),
  errorMessage: text("error_message"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Leads ────────────────────────────────────────────────────────────────────

export const leadStatusEnum = pgEnum("lead_status_enum", ["success", "fail"]);

export const leadsTable = pgTable("leads", {
  ...defaultColumns(),
  status: leadStatusEnum().notNull(),
  companyName: varchar().notNull(),
  email: varchar(),
  website: varchar(),
  phone: varchar(),
  address: varchar(),
  sourceQuery: varchar(),
  placeId: varchar().unique(),
});

export const copilotLeadStatusEnum = pgEnum("copilot_lead_status_enum", [
  "new",
  "sent",
  "failed",
]);

export const copilotLeadsTable = pgTable("copilot_leads", {
  ...defaultColumns(),
  copilotId: integer().references(() => copilotsTable.id),
  leadId: integer().references(() => leadsTable.id),
  status: copilotLeadStatusEnum().notNull().default("new"),
  sentAt: timestamp(),
  failedAt: timestamp(),
  errorMessage: text(),
});

// ─── Copilots ─────────────────────────────────────────────────────────────────

export const copilotsTable = pgTable("copilots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 150 }).notNull(),
  description: text("description"),
  sendLimit: integer("send_limit"),
  // sendLimitActive: boolean().notNull().default(false),
  status: copilotStatusEnum("status").notNull().default("draft"),
  emailProfileId: integer("email_profile_id").references(
    () => emailProfilesTable.id,
    {
      onDelete: "set null",
    },
  ),
  scrapeProfileId: integer("scrape_profile_id").references(
    () => scrapeProfilesTable.id,
    {
      onDelete: "set null",
    },
  ),
  templateId: integer("template_id").references(() => emailTemplatesTable.id, {
    onDelete: "set null",
  }),
  settings: jsonb("settings")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  emailsSent: integer("emails_sent").notNull().default(0),
  emailsOpened: integer("emails_opened").notNull().default(0),
  emailsReplied: integer("emails_replied").notNull().default(0),
  lastRunAt: timestamp("last_run_at"),
  lastJobId: integer("last_job_id").references(() => scrapeJobsTable.id, {
    onDelete: "set null",
  }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Billing / Subscriptions ──────────────────────────────────────────────────

export const subscriptionsTable = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
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

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  subscriptionId: integer("subscription_id").references(
    () => subscriptionsTable.id,
    {
      onDelete: "set null",
    },
  ),
  molliePaymentId: varchar("mollie_payment_id", { length: 255 }),
  amount: integer("amount").notNull(),
  currency: varchar("currency", { length: 10 }).notNull().default("eur"),
  status: invoiceStatusEnum("status").notNull().default("pending"),
  downloadUrl: text("download_url"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const usageTable = pgTable("usage", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  subscriptionId: integer("subscription_id").references(
    () => subscriptionsTable.id,
    { onDelete: "set null" },
  ),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  emailsSent: integer("emails_sent").notNull().default(0),
  copilotsCreated: integer("copilots_created").notNull().default(0),
  emailProfilesCreated: integer("email_profiles_created").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Type exports ─────────────────────────────────────────────────────────────

export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;

export type EmailProfile = typeof emailProfilesTable.$inferSelect;
export type NewEmailProfile = typeof emailProfilesTable.$inferInsert;

export type EmailTemplate = typeof emailTemplatesTable.$inferSelect;
export type NewEmailTemplate = typeof emailTemplatesTable.$inferInsert;

export type ScrapeProfile = typeof scrapeProfilesTable.$inferSelect;
export type NewScrapeProfile = typeof scrapeProfilesTable.$inferInsert;

export type ScrapeJob = typeof scrapeJobsTable.$inferSelect;
export type NewScrapeJob = typeof scrapeJobsTable.$inferInsert;

export type Lead = typeof leadsTable.$inferSelect;
export type NewLead = typeof leadsTable.$inferInsert;

export type CopilotLead = typeof copilotLeadsTable.$inferSelect;
export type NewCopilotLead = typeof copilotLeadsTable.$inferInsert;

export type Copilot = typeof copilotsTable.$inferSelect;
export type NewCopilot = typeof copilotsTable.$inferInsert;

export type Subscription = typeof subscriptionsTable.$inferSelect;
export type NewSubscription = typeof subscriptionsTable.$inferInsert;

export type Invoice = typeof invoicesTable.$inferSelect;
export type NewInvoice = typeof invoicesTable.$inferInsert;
