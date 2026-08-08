import { z } from "zod";

export const subscribeSchema = z.object({
  planId: z.enum(["starter", "growth", "scale"]),
});

export type SubscribeInput = z.infer<typeof subscribeSchema>;
