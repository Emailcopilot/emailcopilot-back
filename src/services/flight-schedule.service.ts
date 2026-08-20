import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import { flightScheduleTable } from "../db/schema";
import { and, desc, eq } from "drizzle-orm";
import type {
  CreateFlightScheduleInput,
  UpdateFlightScheduleInput,
} from "../validators/flight-schedule.validator";

export async function listFlightSchedules(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const rows = await db
    .select()
    .from(flightScheduleTable)
    .where(eq(flightScheduleTable.userId, userId))
    .orderBy(desc(flightScheduleTable.createdAt));
  res.json(rows);
}

export async function getFlightSchedule(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  const [row] = await db
    .select()
    .from(flightScheduleTable)
    .where(
      and(eq(flightScheduleTable.id, id), eq(flightScheduleTable.userId, userId)),
    );
  if (!row)
    throw Object.assign(new Error("Flight schedule not found"), {
      statusCode: 404,
    });
  res.json(row);
}

export async function createFlightSchedule(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const data = req.body as CreateFlightScheduleInput;

  const [created] = await db
    .insert(flightScheduleTable)
    .values({ ...data, userId })
    .returning();
  res.status(201).json(created);
}

export async function updateFlightSchedule(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;
  const data = req.body as UpdateFlightScheduleInput;

  const [updated] = await db
    .update(flightScheduleTable)
    .set({ ...data, updatedAt: new Date() })
    .where(
      and(eq(flightScheduleTable.id, id), eq(flightScheduleTable.userId, userId)),
    )
    .returning();
  if (!updated)
    throw Object.assign(new Error("Flight schedule not found"), {
      statusCode: 404,
    });
  res.json(updated);
}

export async function deleteFlightSchedule(
  req: Request<{ id: string }>,
  res: Response,
) {
  const id = Number(req.params.id);
  const userId = req.dbUser!.id;

  await db
    .delete(flightScheduleTable)
    .where(
      and(eq(flightScheduleTable.id, id), eq(flightScheduleTable.userId, userId)),
    );

  res.status(204).send();
}
