import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { subscribeSchema } from "../validators/billing.validator";
import * as billingService from "../services/billing.service";

export const billingRouter: Router = Router();

// GET /billing/plans — public
billingRouter.get("/plans", (_req: Request, res: Response) => {
  res.json(billingService.listPlans());
});

// GET /billing/subscription
billingRouter.get(
  "/subscription",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await billingService.getSubscription(req.dbUser.id));
    } catch (err) {
      next(err);
    }
  },
);

// GET /billing/invoices
billingRouter.get(
  "/invoices",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await billingService.listInvoices(req.dbUser.id));
    } catch (err) {
      next(err);
    }
  },
);

// POST /billing/subscribe
billingRouter.post(
  "/subscribe",
  requireAuth,
  validate(subscribeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await billingService.subscribe(req.dbUser, req.body));
    } catch (err) {
      next(err);
    }
  },
);

// GET /billing/subscribe/return — Mollie redirects here after checkout
billingRouter.get("/subscribe/return", (req: Request, res: Response) => {
  const { planId } = req.query as { planId?: string };
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
  res.redirect(
    `${frontendUrl}/dashboard/billing?plan=${planId ?? ""}&status=pending`,
  );
});

// POST /billing/webhook — called by Mollie, no auth
billingRouter.post("/webhook", async (req: Request, res: Response) => {
  const { id } = req.body as { id?: string };
  if (!id) {
    res.status(400).send("Missing id");
    return;
  }

  try {
    await billingService.processWebhook(id);
    // Known / unrecoverable cases already no-op inside the service.
    res.status(200).send("ok");
  } catch (err) {
    // Unexpected failures (DB/API): return 500 so Mollie retries the webhook.
    console.error("❌ Webhook processing error:", err);
    res.status(500).send("error");
  }
});

// POST /billing/cancel
billingRouter.post(
  "/cancel",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await billingService.cancelSubscription(req.dbUser.id));
    } catch (err) {
      next(err);
    }
  },
);

// GET /billing/limits
billingRouter.get(
  "/limits",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await billingService.getLimits(req.dbUser.id));
    } catch (err) {
      next(err);
    }
  },
);
