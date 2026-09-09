import { z } from "zod";

export const dashboardAnalyticsSchema = z.object({
  period: z.enum(["7d", "14d", "30d"]).default("7d"),
});

export type DashboardAnalyticsInput = z.infer<typeof dashboardAnalyticsSchema>;
