import { db } from "../db/drizzle";
import { emailTemplates } from "../db/schema";
import { eq, desc, and } from "drizzle-orm";
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  PatchTemplateInput,
} from "../validators/template.validator";

export async function listTemplates(userId: number) {
  return db.select().from(emailTemplates).where(eq(emailTemplates.userId, userId)).orderBy(desc(emailTemplates.createdAt));
}

export async function getTemplate(id: number, userId: number) {
  const [row] = await db
    .select()
    .from(emailTemplates)
    .where(and(eq(emailTemplates.userId, userId), eq(emailTemplates.id, id)));
  if (!row) throw Object.assign(new Error("Template not found"), { statusCode: 404 });
  return row;
}

export async function createTemplate(userId: number, data: CreateTemplateInput) {
  const [created] = await db
    .insert(emailTemplates)
    .values({ ...data, userId })
    .returning();
  return created;
}

export async function updateTemplate(id: number, userId: number, data: UpdateTemplateInput) {
  const [updated] = await db
    .update(emailTemplates)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(emailTemplates.userId, userId), eq(emailTemplates.id, id)))
    .returning();
  if (!updated) throw Object.assign(new Error("Template not found"), { statusCode: 404 });
  return updated;
}

export async function patchTemplate(id: number, userId: number, data: PatchTemplateInput) {
  // If we're activating this template, deactivate all others first
  if (data.isActive === true) {
    await db.update(emailTemplates).set({ isActive: false });
  }

  const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };

  const [updated] = await db
    .update(emailTemplates)
    .set(updateData)
    .where(and(eq(emailTemplates.userId, userId), eq(emailTemplates.id, id)))
    .returning();
  if (!updated) throw Object.assign(new Error("Template not found"), { statusCode: 404 });
  return updated;
}

export async function deleteTemplate(id: number, userId: number) {
  await db.delete(emailTemplates).where(and(eq(emailTemplates.userId, userId), eq(emailTemplates.id, id)));
}

export async function duplicateTemplate(id: number, userId: number) {
  const [original] = await db
    .select()
    .from(emailTemplates)
    .where(and(eq(emailTemplates.userId, userId), eq(emailTemplates.id, id)));
  if (!original) throw Object.assign(new Error("Template not found"), { statusCode: 404 });

  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = original;
  const [duplicate] = await db
    .insert(emailTemplates)
    .values({ ...rest, name: `${original.name} (Copy)`, isActive: false, userId })
    .returning();
  return duplicate;
}
