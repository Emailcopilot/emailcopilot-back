import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { targetAudienceTable } from "../db/schema";
import { and, eq } from "drizzle-orm";
import type {
  CreateTargetAudienceInput,
  UpdateTargetAudienceInput,
} from "../validators/target-audience.validator";

export async function listTargetAudiences(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const rows = await db
    .select()
    .from(targetAudienceTable)
    .where(eq(targetAudienceTable.userId, userId));
  res.json(rows);
}

export async function getTargetAudience(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [row] = await db
    .select()
    .from(targetAudienceTable)
    .where(and(eq(targetAudienceTable.id, id), eq(targetAudienceTable.userId, userId)));
  if (!row)
    throw Object.assign(
      new Error("Target audience not found getTargetAudience"),
      { statusCode: 404 },
    );
  res.json(row);
}

export async function createTargetAudience(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const data = req.body as CreateTargetAudienceInput;

  const [created] = await db
    .insert(targetAudienceTable)
    .values({ ...data, userId })
    .returning();
  res.status(201).json(created);
}

export async function updateTargetAudience(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;
  const data = req.body as UpdateTargetAudienceInput;

  const [updated] = await db
    .update(targetAudienceTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(targetAudienceTable.id, id), eq(targetAudienceTable.userId, userId)))
    .returning();
  if (!updated)
    throw Object.assign(
      new Error("Target audience not found updateTargetAudience"),
      { statusCode: 404 },
    );
  res.json(updated);
}

export async function deleteTargetAudience(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  await db
    .delete(targetAudienceTable)
    .where(and(eq(targetAudienceTable.id, id), eq(targetAudienceTable.userId, userId)));
  res.status(204).send();
}
