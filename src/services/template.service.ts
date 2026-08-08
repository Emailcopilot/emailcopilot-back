import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { emailTemplatesTable } from "../db/schema";
import { eq, desc, and } from "drizzle-orm";
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  PatchTemplateInput,
} from "../validators/template.validator";

export async function listTemplates(req: Request, res: Response) {
  const userId = req.dbUser!.id;

  const rows = await db
    .select()
    .from(emailTemplatesTable)
    .where(eq(emailTemplatesTable.userId, userId))
    .orderBy(desc(emailTemplatesTable.createdAt));

  res.json(rows);
}

export async function getTemplate(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [row] = await db
    .select()
    .from(emailTemplatesTable)
    .where(and(eq(emailTemplatesTable.userId, userId), eq(emailTemplatesTable.id, id)));

  if (!row)
    throw Object.assign(new Error("Template not found"), { statusCode: 404 });

  res.json(row);
}

export async function createTemplate(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const data = req.body as CreateTemplateInput;

  const [created] = await db
    .insert(emailTemplatesTable)
    .values({ ...data, userId })
    .returning();

  res.status(201).json(created);
}

export async function updateTemplate(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;
  const data = req.body as UpdateTemplateInput;

  console.log("Updating template", { id, userId, data });

  const [updated] = await db
    .update(emailTemplatesTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(emailTemplatesTable.userId, userId), eq(emailTemplatesTable.id, id)))
    .returning()
    .catch((err) => {
      console.error("Database error during update:", err);
      throw err;
    });

  if (!updated)
    throw Object.assign(new Error("Template not found"), { statusCode: 404 });

  res.json(updated);
}

export async function patchTemplate(
  id: number,
  userId: number,
  data: PatchTemplateInput,
) {
  const [updated] = await db
    .update(emailTemplatesTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(emailTemplatesTable.userId, userId), eq(emailTemplatesTable.id, id)))
    .returning();

  if (!updated)
    throw Object.assign(new Error("Template not found"), { statusCode: 404 });

  return updated;
}

export async function deleteTemplate(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  await db
    .delete(emailTemplatesTable)
    .where(and(eq(emailTemplatesTable.userId, userId), eq(emailTemplatesTable.id, id)));

  res.status(204).send();
}

export async function duplicateTemplate(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [original] = await db
    .select()
    .from(emailTemplatesTable)
    .where(and(eq(emailTemplatesTable.userId, userId), eq(emailTemplatesTable.id, id)));

  if (!original)
    throw Object.assign(new Error("Template not found"), { statusCode: 404 });

  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = original;
  const [duplicate] = await db
    .insert(emailTemplatesTable)
    .values({ ...rest, name: `${original.name} (Copy)`, userId })
    .returning();

  res.status(201).json(duplicate);
}
