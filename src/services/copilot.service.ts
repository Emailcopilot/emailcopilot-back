import { db } from "../db/drizzle";
import { copilots, subscriptions } from "../db/schema";
import { and, desc, eq } from "drizzle-orm";
import { runDailySendJob } from "./mailer.service";
import { incrementUsage } from "../lib/helpers";
import type {
  CreateCopilotInput,
  UpdateCopilotInput,
  UpdateCopilotStatusInput,
} from "../validators/copilot.validator";

async function getActiveSubscription(userId: number) {
  const subs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt));
  const sub = subs[0];
  if (!sub) throw Object.assign(new Error("No subscription found"), { statusCode: 404 });
  return sub;
}

export async function listCopilots(userId: number) {
  return db.select().from(copilots).where(eq(copilots.userId, userId));
}

export async function getCopilot(id: number, userId: number) {
  const [row] = await db
    .select()
    .from(copilots)
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)));
  if (!row) throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  return row;
}

export async function createCopilot(userId: number, data: CreateCopilotInput) {
  const sub = await getActiveSubscription(userId);
  const [created] = await db
    .insert(copilots)
    .values({ ...data, userId })
    .returning();
  await incrementUsage(userId, sub.id, { copilotsCreated: 1 });
  return created;
}

export async function updateCopilot(id: number, userId: number, data: UpdateCopilotInput) {
  const [updated] = await db
    .update(copilots)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)))
    .returning();
  if (!updated) throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });
  return updated;
}

export async function deleteCopilot(id: number, userId: number) {
  await db.delete(copilots).where(and(eq(copilots.id, id), eq(copilots.userId, userId)));
}

export async function updateCopilotStatus(
  id: number,
  userId: number,
  data: UpdateCopilotStatusInput
) {
  const sub = await getActiveSubscription(userId);

  const [updated] = await db
    .update(copilots)
    .set({ status: data.status, updatedAt: new Date() })
    .where(and(eq(copilots.id, id), eq(copilots.userId, userId)))
    .returning();
  if (!updated) throw Object.assign(new Error("Copilot not found"), { statusCode: 404 });

  if (data.status === "active") {
    // Fire-and-forget — don't await, don't block the response
    runDailySendJob(userId, sub.id).catch((err) =>
      console.error("Daily send job error:", err)
    );
  }

  return updated;
}
