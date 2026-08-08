import type { Request, Response } from "express";
import { copilotLeadsTable, copilotsTable, leadsTable } from "../db/schema";
import { db } from "../db/drizzle";
import { eq, desc, and, getTableColumns, isNotNull } from "drizzle-orm";
import type { ListLeadsInput } from "../validators/lead.validator";

export async function listLeads(req: Request, res: Response) {
  const { page, limit, copilotId } = req.query as unknown as ListLeadsInput;
  const userId = req.dbUser!.id;
  const offset = (page - 1) * limit;

  const where = and(
    eq(copilotsTable.userId, userId),
    isNotNull(leadsTable.id),
    copilotId ? eq(copilotLeadsTable.copilotId, copilotId) : undefined,
  );

  const query = () =>
    db
      .select({
        ...getTableColumns(leadsTable),
        sentAt: copilotLeadsTable.sentAt,
        status: copilotLeadsTable.status,
      })
      .from(copilotLeadsTable)
      .leftJoin(copilotsTable, eq(copilotLeadsTable.copilotId, copilotsTable.id))
      .leftJoin(leadsTable, eq(copilotLeadsTable.leadId, leadsTable.id))
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

export async function getLead(req: Request<{ id: string }>, res: Response) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [lead] = await db
    .select({
      ...getTableColumns(leadsTable),
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, id), eq(copilotsTable.userId, userId)))
    .leftJoin(copilotLeadsTable, eq(leadsTable.id, copilotLeadsTable.leadId))
    .leftJoin(copilotsTable, eq(copilotLeadsTable.copilotId, copilotsTable.id));

  if (!lead)
    throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
  res.json(lead);
}
