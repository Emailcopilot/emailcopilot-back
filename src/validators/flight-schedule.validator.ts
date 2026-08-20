import { z } from "zod";
import { getTimezone } from "countries-and-timezones";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);

const ianaTimezone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => getTimezone(value) != null, {
    message: "Invalid timezone",
  });

export const flightScheduleObject = z.object({
  name: z.string().min(1).max(150).optional(),
  sendLimit: z.number().int().positive().optional().nullable(),
  sendLimitActive: z.boolean().optional(),
  activeDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  sendingHours: z.object({ start: hhmm, end: hhmm }).optional(),
  sendingHoursActive: z.boolean().optional(),
  timezone: ianaTimezone.optional(),
});

export const createFlightScheduleSchema = flightScheduleObject.extend({
  name: z.string().min(1).max(150),
});

export const updateFlightScheduleSchema = createFlightScheduleSchema.partial();

export type CreateFlightScheduleInput = z.infer<
  typeof createFlightScheduleSchema
>;
export type UpdateFlightScheduleInput = z.infer<
  typeof updateFlightScheduleSchema
>;
