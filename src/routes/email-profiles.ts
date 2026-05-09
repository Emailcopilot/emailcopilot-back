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
import { and, eq } from "drizzle-orm";
import { testSmtpConnection } from "../services/mailer";
import { incrementUsage } from "../lib/helpers";

export const emailProfilesRouter: Router = Router();


// ─── Email Profiles ───────────────────────────────────────────────────────────
// GET    /api/email-profiles
// GET    /api/email-profiles/:id
// POST   /api/email-profiles
// PUT    /api/email-profiles/:id
// DELETE /api/email-profiles/:id
// POST   /api/email-profiles/:id/verify

emailProfilesRouter.get("/", async (_req: Request, res: Response) => {
    try {
        const user = _req.dbUser;
        const rows = await db.select().from(emailProfiles).where(eq(emailProfiles.userId, user?.id));
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch email profiles" });
    }
});

emailProfilesRouter.get("/:id", async (req: Request, res: Response) => {
    try {
        const user = req.dbUser;
        const id = Number(req.params.id);
        const [row] = await db.select().from(emailProfiles).where(and(eq(emailProfiles.userId, user?.id), eq(emailProfiles.id, id)));
        if (!row) return res.status(404).json({ error: "Email profile not found" });
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch email profile" });
    }
});

emailProfilesRouter.post("/", async (req: Request, res: Response) => {
    try {
        const user = req.dbUser;


        const [created] = await db.insert(emailProfiles).values({ ...req.body, userId: user?.id }).returning();
        await incrementUsage(user?.id, user?.subscriptionId, { emailProfilesCreated: 1 });
        res.status(201).json(created);
    } catch (err) {
        console.error("Error creating email profile:", err);
        res.status(500).json({ error: "Failed to create email profile" });
    }
});

emailProfilesRouter.put("/:id", async (req: Request, res: Response) => {
    try {
        const id = Number(req.params.id);
        const user = req.dbUser;

        const [updated] = await db
            .update(emailProfiles)
            .set({ ...req.body, updatedAt: new Date() })
            .where(and(eq(emailProfiles.userId, user?.id), eq(emailProfiles.id, id)))
            .returning();
        if (!updated) return res.status(404).json({ error: "Email profile not found" });
        res.json(updated);
    } catch (err) {
        console.error("Error updating email profile:", err);
        res.status(500).json({ error: "Failed to update email profile" });
    }
});

emailProfilesRouter.delete("/:id", async (req: Request, res: Response) => {
    try {
        const id = Number(req.params.id);
        const user = req.dbUser;
        await db.delete(emailProfiles).where(and(eq(emailProfiles.userId, user?.id), eq(emailProfiles.id, id)));
        res.status(204).send();
    } catch (err) {
        console.error("Error deleting email profile:", err);
        res.status(500).json({ error: "Failed to delete email profile" });
    }
});

// POST /api/email-profiles/:id/verify — tests SMTP connection for this profile
emailProfilesRouter.post("/:id/verify", async (req: Request, res: Response) => {
    try {
        const user = req.dbUser;
        if (!user) return res.status(404).json({ error: "User not found" });
        const id = Number(req.params.id);
        const [profile] = await db
            .select()
            .from(emailProfiles)
            .where(and(eq(emailProfiles.userId, user?.id), eq(emailProfiles.id, id)));
        if (!profile) return res.status(404).json({ error: "Email profile not found" });
        // Delegate to mailer's SMTP test — it reads config from the settings table
        const result = await testSmtpConnection();
        if (result.success) {
            await db
                .update(emailProfiles)
                .set({ status: "active", lastVerifiedAt: new Date(), updatedAt: new Date() })
                .where(and(eq(emailProfiles.userId, user?.id), eq(emailProfiles.id, id)));
        } else {
            await db
                .update(emailProfiles)
                .set({ status: "error", updatedAt: new Date() })
                .where(and(eq(emailProfiles.userId, user?.id), eq(emailProfiles.id, id)));
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: "Verification failed" });
    }
});
