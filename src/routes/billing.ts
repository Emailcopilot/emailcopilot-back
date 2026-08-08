import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { subscribeSchema } from "../validators/billing.validator";
import * as billingService from "../services/billing.service";

export const billingRouter: Router = Router();

billingRouter.get("/plans", billingService.listPlans);

billingRouter.get("/subscription", requireAuth, billingService.getSubscription);

billingRouter.get("/invoices", requireAuth, billingService.listInvoices);

billingRouter.post(
  "/subscribe",
  requireAuth,
  validate(subscribeSchema),
  billingService.subscribe,
);

billingRouter.get("/subscribe/return", billingService.subscribeReturn);

billingRouter.post("/webhook", billingService.processWebhook);

billingRouter.post("/cancel", requireAuth, billingService.cancelSubscription);

billingRouter.get("/limits", requireAuth, billingService.getLimits);
