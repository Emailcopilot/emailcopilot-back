import { Router, Request, Response } from "express";
import { db } from "../db/drizzle";
import {
    emailProfiles,
    scrapeProfiles,
    emailTemplates,
    copilots,
    integrations,
    settings,
    subscriptions,
    invoices,
    leads,
    scrapeJobs,
    users,
} from "../db/schema";
import { eq } from "drizzle-orm";
import { runDailySendJob, testSmtpConnection } from "../services/mailer";
import { runScrapeJob } from "../services/scraper";

export const billingRouter: Router = Router();



// ─── Billing ──────────────────────────────────────────────────────────────────
// GET  /api/billing/subscription
// GET  /api/billing/invoices
// GET  /api/billing/plans
// POST /api/billing/subscribe
// POST /api/billing/cancel
// PUT  /api/billing/payment-method

billingRouter.get("/subscription", async (req: Request, res: Response) => {
    try {
        const user = req.dbUser;

        const subscription = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id)).limit(1);
        if (subscription.length === 0) return res.status(404).json({ error: "Subscription not found" });
        res.json(subscription[0]);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch subscription" });
    }
});

billingRouter.get("/invoices", async (req: Request, res: Response) => {
    try {
        const user = req.dbUser;

        const rows = await db.select().from(invoices).where(eq(invoices.userId, user.id));
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch invoices" });
    }
});

billingRouter.get("/plans", async (_req: Request, res: Response) => {
    // Static plan definitions — swap with Stripe Products API if needed
    res.json([
        { id: "starter", name: "Starter", price: 9, interval: "month", features: ["3 Copilots", "1 Email Profile", "500 emails/mo", "Basic templates", "Email support"] },
        { id: "growth", name: "Growth", price: 19, interval: "month", features: ["15 Copilots", "5 Email Profiles", "5,000 emails/mo", "Unlimited templates", "Priority support", "API access"], highlight: true },
        { id: "scale", name: "Scale", price: 39, interval: "month", features: ["Unlimited Copilots", "20 Email Profiles", "25,000 emails/mo", "Custom templates", "Dedicated support", "API access", "Team seats"] },
    ]);
});

billingRouter.post("/subscribe", async (req: Request, res: Response) => {
    try {
        const user = req.dbUser;

        const { planId } = req.body as { planId: string };
        if (!planId) return res.status(400).json({ error: "planId is required" });
        // Stub: real impl would call Stripe and create a subscription row
        res.json({ message: `Subscribed to ${planId}` });
    } catch (err) {
        res.status(500).json({ error: "Failed to subscribe" });
    }
});

billingRouter.post("/cancel", async (_req: Request, res: Response) => {
    try {
        // Stub: real impl would call Stripe and set cancelAtPeriodEnd = true
        res.json({ message: "Subscription will cancel at period end" });
    } catch (err) {
        res.status(500).json({ error: "Failed to cancel subscription" });
    }
});

billingRouter.put("/payment-method", async (req: Request, res: Response) => {
    try {
        // Stub: real impl would call Stripe to attach a new payment method
        res.json({ message: "Payment method updated" });
    } catch (err) {
        res.status(500).json({ error: "Failed to update payment method" });
    }
});
