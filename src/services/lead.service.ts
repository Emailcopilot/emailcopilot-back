import type { Request, Response } from "express";
import { copilotLeadsTable, copilots, leads2Table } from "./../db/schema";
import { db } from "../db/drizzle";
import { leads } from "../db/schema";
import { eq, desc, count, and, getTableColumns, isNotNull } from "drizzle-orm";
import type {
  PatchLeadInput,
  ListLeadsInput,
} from "../validators/lead.validator";

export async function listLeads(req: Request, res: Response) {
  const { page, limit, copilotId } = req.query as unknown as ListLeadsInput;
  const userId = req.dbUser!.id;
  const offset = (page - 1) * limit;

  const where = and(
    eq(copilots.userId, userId),
    isNotNull(copilotLeadsTable.id),
    copilotId ? eq(copilotLeadsTable.copilotId, copilotId) : undefined,
  );

  const query = () =>
    db
      .select({
        ...getTableColumns(leads2Table),
        sentAt: copilotLeadsTable.sentAt,
        status: copilotLeadsTable.status,
      })
      .from(leads2Table)
      .leftJoin(copilotLeadsTable, eq(leads2Table.id, copilotLeadsTable.leadId))
      .leftJoin(copilots, eq(copilotLeadsTable.copilotId, copilots.id))
      .where(where);

  const [rows, total] = await Promise.all([
    query()
      .orderBy(desc(copilotLeadsTable.createdAt))
      .offset(offset)
      .limit(limit),
    db.$count(query()),
  ]);

  res.json({
    data: rows,
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
}

export async function getLeadStats(_req: Request, res: Response) {
  const rows = await db
    .select({ status: leads.status, count: count() })
    .from(leads)
    .groupBy(leads.status);

  type SummaryKey = "new" | "queued" | "sent" | "replied" | "disqualified";
  const summary = {
    new: 0,
    queued: 0,
    sent: 0,
    replied: 0,
    disqualified: 0,
    total: 0,
  };
  for (const row of rows) {
    summary[row.status as SummaryKey] = Number(row.count);
    summary.total += Number(row.count);
  }
  res.json(summary);
}

export async function getLead(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [lead] = await db
    .select({
      ...getTableColumns(leads2Table),
    })
    .from(leads2Table)
    .where(and(eq(leads2Table.id, id), eq(copilots.userId, userId)))
    .leftJoin(copilotLeadsTable, eq(leads2Table.id, copilotLeadsTable.leadId))
    .leftJoin(copilots, eq(copilotLeadsTable.copilotId, copilots.id));

  if (!lead)
    throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
  res.json(lead);
}

export async function patchLead(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  const data = req.body as PatchLeadInput;
  const updateData: Record<string, unknown> = {};
  if (data.status) updateData.status = data.status;
  if (data.notes !== undefined) updateData.notes = data.notes;
  if (data.status === "replied") updateData.repliedAt = new Date();

  const [lead] = await db
    .update(leads)
    .set(updateData)
    .where(eq(leads.id, id))
    .returning();
  if (!lead)
    throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
  res.json(lead);
}

export async function deleteLead(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  await db.delete(leads).where(eq(leads.id, id));
  res.json({ success: true });
}
