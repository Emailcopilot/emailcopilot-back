import { copilotLeadsTable, copilots, leads2Table } from "./../db/schema";
import { db } from "../db/drizzle";
import { leads, emailLogs } from "../db/schema";
import { eq, desc, count, sql, and, getTableColumns } from "drizzle-orm";
import type { LeadStatus } from "../db/types";
import type {
  PatchLeadInput,
  ListLeadsInput,
} from "../validators/lead.validator";

export async function listLeads(
  { status, page, limit }: ListLeadsInput,
  userId: number,
) {
  // console.log("listLeads", status, page, limit, userId);
  const offset = (page - 1) * limit;
  const where = and(
    // status ? eq(leads2Table.status, status as LeadStatus2) : undefined,
    eq(copilots.userId, userId),
  );

  const query = () =>
    db
      .select({
        ...getTableColumns(leads2Table),
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

  return {
    data: rows,
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

export async function getLeadStats() {
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
  return summary;
}

export async function getLead(id: number) {
  const [lead] = await db
    .select({
      ...getTableColumns(leads2Table),
    })
    .from(leads2Table)
    .where(and(eq(leads2Table.id, id)))
    .leftJoin(copilotLeadsTable, eq(leads2Table.id, copilotLeadsTable.leadId))
    .leftJoin(copilots, eq(copilotLeadsTable.copilotId, copilots.id));

  if (!lead)
    throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
  return lead;
}

export async function patchLead(id: number, data: PatchLeadInput) {
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
  return lead;
}

export async function deleteLead(id: number) {
  await db.delete(leads).where(eq(leads.id, id));
}
