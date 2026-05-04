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
} from "../db/schema";
import { and, eq } from "drizzle-orm";
import { runDailySendJob, testSmtpConnection } from "../services/mailer";
import { runScrapeJob } from "../services/scraper";

export const copilotsRouter: Router = Router();


// ─── Copilots ─────────────────────────────────────────────────────────────────
// GET    /api/copilots
// GET    /api/copilots/:id
// POST   /api/copilots
// PUT    /api/copilots/:id
// DELETE /api/copilots/:id
// PATCH  /api/copilots/:id/status

copilotsRouter.get("/", async (req: Request, res: Response) => {
    try {
        const user = req.dbUser;
        const rows = await db.select().from(copilots).where(eq(copilots.userId, user.id));
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch copilots" });
    }
});

copilotsRouter.get("/:id", async (req: Request, res: Response) => {
    try {
        const id = Number(req.params.id);
        const user = req.dbUser;
        const [row] = await db.select().from(copilots).where(and(eq(copilots.id, id), eq(copilots.userId, user.id)));
        if (!row) return res.status(404).json({ error: "Copilot not found" });
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch copilot" });
    }
});

copilotsRouter.post("/", async (req: Request, res: Response) => {
    try {
        const user = req.dbUser;
        const [created] = await db.insert(copilots).values({ ...req.body, userId: user.id }).returning();
        res.status(201).json(created);
    } catch (err) {
        console.error("Error creating copilot:", err);
        res.status(500).json({ error: "Failed to create copilot" });
    }
});

copilotsRouter.put("/:id", async (req: Request, res: Response) => {
    try {
        const user = req.dbUser;
        const id = Number(req.params.id);
        const [updated] = await db
            .update(copilots)
            .set({ ...req.body, updatedAt: new Date() })
            .where(and(eq(copilots.id, id), eq(copilots.userId, user.id)))
            .returning();
        if (!updated) return res.status(404).json({ error: "Copilot not found" });
        res.json(updated);
    } catch (err) {
        console.error("Error updating copilot:", err);
        res.status(500).json({ error: "Failed to update copilot" });
    }
});

copilotsRouter.delete("/:id", async (req: Request, res: Response) => {
    try {
        const id = Number(req.params.id);
        const user = req.dbUser;
        await db.delete(copilots).where(and(eq(copilots.id, id), eq(copilots.userId, user.id)));
        res.status(204).send();
    } catch (err) {
        console.error("Error deleting copilot:", err);
        res.status(500).json({ error: "Failed to delete copilot" });
    }
});

// PATCH /api/copilots/:id/status — matches copilotsApi.updateStatus() in api.ts
copilotsRouter.patch("/:id/status", async (req: Request, res: Response) => {
    try {
        const id = Number(req.params.id);
        const user = req.dbUser;
        const { status } = req.body as {
            status: "draft" | "active" | "paused" | "archived";
        };
        const [updated] = await db
            .update(copilots)
            .set({ status, updatedAt: new Date() })
            .where(and(eq(copilots.id, id), eq(copilots.userId, user.id)))
            .returning();
        if (!updated) return res.status(404).json({ error: "Copilot not found" });

        // When a copilot is activated, trigger the daily send job
        if (status === "active") {
            runDailySendJob().catch((err) =>
                console.error("Daily send job error:", err)
            );
        }

        res.json(updated);
    } catch (err) {
        console.error("Error updating copilot status:", err);
        res.status(500).json({ error: "Failed to update copilot status" });
    }
});
