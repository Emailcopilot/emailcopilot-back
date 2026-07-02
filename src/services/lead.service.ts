import { db } from "../db/drizzle";
import { leads, emailLogs } from "../db/schema";
import { eq, desc, count, sql, and } from "drizzle-orm";
import type { LeadStatus } from "../db/types";
import type {
  PatchLeadInput,
  ListLeadsInput,
} from "../validators/lead.validator";

export async function listLeads(
  { status, page, limit }: ListLeadsInput,
  userId: number,
) {
  const offset = (page - 1) * limit;
  const where = and(
    status ? eq(leads.status, status as LeadStatus) : undefined,
    eq(leads.userId, userId),
  );

  const [rows, totalRows] = await Promise.all([
    db.query.leads.findMany({
      where,
      orderBy: desc(leads.scrapedAt),
      limit,
      offset,
      with: {
        emailLogs: {
          orderBy: desc(emailLogs.sentAt),
          limit: 1,
        },
      },
    }),
    db
      .select({ total: count() })
      .from(leads)
      .where(where ?? sql`1=1`),
  ]);

  const total = Number(totalRows[0].total);
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
  const lead = await db.query.leads.findFirst({
    where: eq(leads.id, id),
    with: { emailLogs: { orderBy: desc(emailLogs.sentAt) } },
  });
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
