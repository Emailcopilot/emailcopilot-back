import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import { dashboardAnalyticsSchema } from "../validators/analytics.validator";
import * as analyticsService from "../services/analytics.service";

export const analyticsRouter: Router = Router();

analyticsRouter.get(
  "/dashboard",
  validate(dashboardAnalyticsSchema, "query"),
  analyticsService.getDashboardAnalytics,
);
