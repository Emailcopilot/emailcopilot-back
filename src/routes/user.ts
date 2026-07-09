import { Router, Request, Response } from "express";
import { db } from "../db/drizzle";
import { emailTemplates, users } from "../db/schema";
import { eq } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { verifyWebhook } from "@clerk/express/webhooks";

export const usersRouter: Router = Router();

async function resolveUser(
  req: Request,
  res: Response,
): Promise<typeof users.$inferSelect | null> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const user = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .then((r) => r[0]);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  return user;
}

// ─── Users ─────────────────────────────────────────────
// GET    /api/users
// GET    /api/users/:id
// POST   /api/users
// PUT    /api/users/:id
// DELETE /api/users/:id

usersRouter.get("/", async (req: Request, res: Response) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;

    const rows = await db.select().from(users);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

usersRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;

    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, req.params.id));
    if (!row) return res.status(404).json({ error: "User not found" });
    res.json(row);
  } catch (err) {
    console.error("Error fetching user:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

usersRouter.post("/webhook", async (req: Request, res: Response) => {
  try {
    const evt = await verifyWebhook(req);
    const eventType = evt.type;

    if (eventType === "user.created") {
      const data = evt.data;
      const existing = await db
        .select()
        .from(users)
        .where(eq(users.clerkId, data.id!));

      if (existing.length > 0) {
        return res.send("User already exists");
      }

      const [created] = await db
        .insert(users)
        .values({
          clerkId: data.id,
          firstName: data.first_name,
          lastName: data.last_name,
          email: data.email_addresses[0]?.email_address || "",
        })
        .returning();

      await db.insert(emailTemplates).values({
        userId: created.id,
        name: "Default Outreach Template",
        subject: "Quick question about {{companyName}}",
        body: `Hi,\n\nI came across {{companyName}} and wanted to reach out...\n\nBest,\n{{senderName}}`,
        category: "Cold Outreach",
        variables: ["companyName", "senderName"],
      });

      return res.send("User created successfully");
    }

    res.send("Webhook received successfully");
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

usersRouter.post("/", async (req: Request, res: Response) => {
  try {
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, req.body.clerkId));
    if (existing.length > 0) {
      return res.status(400).json({ error: "User already exists" });
    }
    const [created] = await db.insert(users).values(req.body).returning();
    await db.insert(emailTemplates).values({
      userId: created.id,
      name: "Default Outreach Template",
      subject: "Quick question about {{companyName}}",
      body: `Hi,\n\nI came across {{companyName}} and wanted to reach out...\n\nBest,\n{{senderName}}`,
      category: "Cold Outreach",
      variables: ["companyName", "senderName"],
    });
    res.status(201).json(created);
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

usersRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;

    const [updated] = await db
      .update(users)
      .set(req.body)
      .where(eq(users.clerkId, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "User not found" });
    res.json(updated);
  } catch (err) {
    console.error("Error updating user:", err);

    res.status(500).json({ error: "Failed to update user" });
  }
});

usersRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;

    const [deleted] = await db
      .delete(users)
      .where(eq(users.clerkId, req.params.id))
      .returning();
    if (!deleted) return res.status(404).json({ error: "User not found" });
    res.json(deleted);
  } catch (err) {
    console.error("Error deleting user:", err);

    res.status(500).json({ error: "Failed to delete user" });
  }
});
