import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { emailLogs } from "../db/schema";
import { desc } from "drizzle-orm";

export async function listEmailLogs(req: Request, res: Response) {
  const { page, limit } = req.query as unknown as {
    page: number;
    limit: number;
  };
  const offset = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    db.query.emailLogs.findMany({
      orderBy: desc(emailLogs.sentAt),
      limit,
      offset,
      with: {
        lead: { columns: { id: true, companyName: true, email: true } },
        template: { columns: { id: true, name: true } },
      },
    }),
    db.$count(emailLogs),
  ]);

  res.json({
    data: rows,
    meta: {
      total: Number(total),
      page,
      limit,
      totalPages: Math.ceil(Number(total) / limit),
    },
  });
}
