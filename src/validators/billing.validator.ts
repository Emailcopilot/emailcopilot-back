import { z } from "zod";

export const subscribeSchema = z.object({
  planId: z.enum(["starter", "growth", "scale"]),
  interval: z.enum(["month", "year"]).default("month"),
});

export type SubscribeInput = z.infer<typeof subscribeSchema>;
