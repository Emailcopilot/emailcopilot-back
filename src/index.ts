import "dotenv/config";
import express from "express";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";

// ─── Middleware ───────────────────────────────────────────────────────────────
import { requireAuth } from "./middleware/auth.middleware";
import { errorHandler } from "./middleware/error.middleware";

// ─── Routes ───────────────────────────────────────────────────────────────────
import { leadsRouter } from "./routes/leads";
import { emailsRouter } from "./routes/emails";
import { scrapeJobsRouter } from "./routes/scrape-jobs";
import { templatesRouter } from "./routes/templates";
import { billingRouter } from "./routes/billing";
import { copilotsRouter } from "./routes/copilots";
import { emailProfilesRouter } from "./routes/email-profiles";
import { scrapeProfilesRouter } from "./routes/scrape-profiles";
import { usersRouter } from "./routes/user";

// ─── Services ─────────────────────────────────────────────────────────────────
import { periodicSendScheduler } from "./services/mailer.service";
import runScraping from "./scraping";

// ─── DB ───────────────────────────────────────────────────────────────────────
import { db } from "./db/drizzle";
import BrowserManager from "./scraping/browserManager";
import morgan from "morgan";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// ─── App ──────────────────────────────────────────────────────────────────────
const app: express.Application = express();
const PORT = process.env.PORT || 3001;

// ─── Global middleware ────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true })); // required for Mollie webhooks
app.use(express.json());
const origin = process.env.ALLOWED_ORIGIN?.split(",");
console.log("origin", origin);
app.use(
  cors({
    origin: origin || "http://localhost:3000",
    // methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    // allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);
app.use(clerkMiddleware());
app.use(morgan("combined"));
app.set("trust proxy", 1);

// ─── Public routes ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Billing is partially public: /billing/webhook must be reachable by Mollie
// without auth, and /billing/plans is public. Auth is handled inside the router
// per-route via getAuth(), so we mount it without requireAuth here.
app.use("/billing", billingRouter);

// ─── Authenticated routes ────────────────────────────────────────────────────
// requireAuth resolves the Clerk session to req.dbUser for all routes below
app.use("/users", usersRouter);

app.use(requireAuth);

app.use("/leads", leadsRouter);
app.use("/emails", emailsRouter);
app.use("/templates", templatesRouter);
app.use("/copilots", copilotsRouter);
app.use("/scrape-jobs", scrapeJobsRouter);
app.use("/email-profiles", emailProfilesRouter);
app.use("/scrape-profiles", scrapeProfilesRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── Central error handler (must be last) ────────────────────────────────────

app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`✅ API running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  await migrate(db, { migrationsFolder: "./migrations" });
  console.log("✅ Migrations applied");

  const browserManager = new BrowserManager();
  await browserManager.getBrowser();

  runScraping(browserManager);
  periodicSendScheduler();

  process.on("SIGINT", async () => {
    await browserManager.closeBrowser();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await browserManager.closeBrowser();
    process.exit(0);
  });

  process.on("SIGQUIT", async () => {
    await browserManager.closeBrowser();
    process.exit(0);
  });
});

export default app;
