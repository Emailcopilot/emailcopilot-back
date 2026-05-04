import "dotenv/config";
import express from "express";
import cors from "cors";
import { requireApiKey } from "./middleware/auth";
import { leadsRouter } from "./routes/leads";
import { emailsRouter } from "./routes/emails";
import { scraperRouter } from "./routes/scraper";
import { settingsRouter } from "./routes/settings";
import { templatesRouter } from "./routes/templates";
import { billingRouter } from "./routes/billing";
import { copilotsRouter } from "./routes/copilots";
import { integrationsRouter } from "./routes/integrations";
import { scrapeJobsRouter } from "./routes/scrape-jobs";
import { emailProfilesRouter } from "./routes/email-profiles";
import { scrapeProfilesRouter } from "./routes/scrape-profiles";
import { runDailySendJob } from "./services/mailer";
import { initScheduler, getSchedulerStatus } from "./services/scheduler";
import { usersRouter } from "./routes/user";
import { clerkMiddleware } from "@clerk/express";


const app: express.Application = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST", "PATCH", "DELETE", "PUT"], // ← also missing PUT
    allowedHeaders: ["Content-Type", "Authorization"], // ← add this
    credentials: true,
  })
);
app.use(clerkMiddleware())

// ─── Public routes ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Protected routes (API key required) ─────────────────────────────────────

app.use("/leads", requireApiKey, leadsRouter);
app.use("/emails", requireApiKey, emailsRouter);
app.use("/scraper", requireApiKey, scraperRouter);
app.use("/settings", requireApiKey, settingsRouter);
app.use("/templates", requireApiKey, templatesRouter);
app.use("/billing", requireApiKey, billingRouter);
app.use("/copilots", requireApiKey, copilotsRouter);
app.use("/integrations", requireApiKey, integrationsRouter);
app.use("/scrape-jobs", requireApiKey, scrapeJobsRouter);
app.use("/email-profiles", requireApiKey, emailProfilesRouter);
app.use("/scrape-profiles", requireApiKey, scrapeProfilesRouter);
app.use("/users", requireApiKey, usersRouter);

// manual trigger for the daily send job (useful for testing without waiting for cron)
app.post("/send-now", requireApiKey, async (_req, res) => {
  try {
    runDailySendJob().catch(console.error);
    res.json({ message: "Send job triggered. Check server logs for progress." });
  } catch (error) {
    res.status(500).json({ error: "Failed to trigger send job" });
  }
});

// scheduler status — shows which cron jobs are active
app.get("/scheduler/status", requireApiKey, (_req, res) => {
  res.json(getSchedulerStatus());
});

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`✅ API running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);

  // start cron jobs
  await initScheduler();
});

export default app;