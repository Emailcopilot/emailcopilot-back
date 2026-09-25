import { badRequest, notFound } from "../lib/http-error";
import type { Request, Response } from "express";
import {
  copilotLeadsTable,
  copilotsTable,
  emailTemplatesTable,
  leadsTable,
  suppressedEmailsTable,
} from "../db/schema";
import { db } from "../db/drizzle";
import { eq, desc, and, getTableColumns, isNotNull, sql } from "drizzle-orm";
import type {
  ListLeadsInput,
  UpdateLeadSuppressionInput,
} from "../validators/lead.validator";

const normalizeEmail = (email: string) => email.trim().toLowerCase();

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
        templateId: copilotsTable.templateId,
        copilotName: copilotsTable.name,
        sentAt: copilotLeadsTable.sentAt,
        status: copilotLeadsTable.status,
        suppressed: sql`case when ${suppressedEmailsTable.id} is not null then true else false end`,
      })
      .from(copilotLeadsTable)
      .leftJoin(
        copilotsTable,
        eq(copilotLeadsTable.copilotId, copilotsTable.id),
      )
      .leftJoin(leadsTable, eq(copilotLeadsTable.leadId, leadsTable.id))
      .leftJoin(
        emailTemplatesTable,
        eq(copilotsTable.templateId, emailTemplatesTable.id),
    )
      .leftJoin(
        suppressedEmailsTable,
        and(
          eq(suppressedEmailsTable.userId, userId),
          eq( sql`lower(trim(${suppressedEmailsTable.email}))`, sql`lower(trim(${leadsTable.email}))` ),
        ),
      )
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
    throw notFound("Lead not found");
  res.json(lead);
}

export async function updateLeadSuppression(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const { doNotContact } = req.body as UpdateLeadSuppressionInput;
  const userId = req.dbUser!.id;

  const [lead] = await db
    .select({ id: leadsTable.id, email: leadsTable.email })
    .from(leadsTable)
    .innerJoin(copilotLeadsTable, eq(copilotLeadsTable.leadId, leadsTable.id))
    .innerJoin(copilotsTable, eq(copilotLeadsTable.copilotId, copilotsTable.id))
    .where(and(eq(leadsTable.id, id), eq(copilotsTable.userId, userId)))
    .limit(1);

  if (!lead) {
    throw notFound("Lead not found");
  }
  if (!lead.email) {
    throw badRequest("Lead has no email address");
  }

  const email = normalizeEmail(lead.email);
  if (doNotContact) {
    await db
      .insert(suppressedEmailsTable)
      .values({ userId, email })
      .onConflictDoNothing();
  } else {
    await db
      .delete(suppressedEmailsTable)
      .where(
        and(
          eq(suppressedEmailsTable.userId, userId),
          eq( sql`lower(trim(${suppressedEmailsTable.email}))`, sql`lower(trim(${email}))` ),
        ),
      );
  }

  res.json({ doNotContact });
}
