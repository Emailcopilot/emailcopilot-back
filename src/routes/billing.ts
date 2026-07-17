import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db/drizzle";
import {
  subscriptions,
  invoices,
  users,
  usage,
  copilots,
  emailProfiles,
} from "../db/schema";
import { eq, desc, and, lte, gte, ne, count } from "drizzle-orm";
import createMollieClient, {
  MollieClient,
  SequenceType,
} from "@mollie/api-client";
import { getAuth } from "@clerk/express";
import { z } from "zod";
import { validate } from "../middleware/validate.middleware";

export const billingRouter: Router = Router();

// ─── Mollie Client ─────────────────────────────────────────────────────────────
const mollie: MollieClient = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY!,
});

// ─── Plans ─────────────────────────────────────────────────────────────────────
const PLANS = [
  {
    id: "starter",
    name: "Starter",
    price: 9,
    amount: "9.00",
    interval: "1 month",
    currency: "EUR",
    maxEmailsPerMonth: 250,
    maxCopilots: 1,
    maxEmailProfiles: 1,
    features: [
      "1 Copilots",
      "1 SMTP account",
      "250 emails (~8/day)",
      "Standard delivery speed",
      "No data export",
    ],
  },
  {
    id: "growth",
    name: "Growth",
    price: 19,
    amount: "19.00",
    interval: "1 month",
    currency: "EUR",
    maxEmailsPerMonth: 750,
    maxCopilots: 3,
    maxEmailProfiles: 3,
    highlight: true,
    features: [
      "3 Copilots",
      "3 SMTP accounts",
      "750 emails (~26/day)",
      "Faster delivery speed",
      "Limited data export",
    ],
  },
  {
    id: "scale",
    name: "Scale",
    price: 39,
    amount: "39.00",
    interval: "1 month",
    currency: "EUR",
    maxEmailsPerMonth: 2000,
    maxCopilots: Infinity,
    maxEmailProfiles: Infinity,
    features: [
      "Unlimited Copilots",
      "Unlimited SMTP accounts",
      "2000 emails (~65/day)",
      "Priority delivery speed",
      "Full data export",
    ],
  },
] as const;

type PlanId = (typeof PLANS)[number]["id"];

export function getPlan(planId: string) {
  return PLANS.find((p) => p.id === planId) ?? null;
}

// ─── Plan limits ───────────────────────────────────────────────────────────────
const PLAN_LIMITS: Record<
  PlanId,
  {
    emailsPerMonth: number;
    copilots: number;
    emailProfiles: number;
    hasApiAccess: boolean;
    hasUnlimitedTemplates: boolean;
  }
> = {
  starter: {
    emailsPerMonth: 250,
    copilots: 1,
    emailProfiles: 1,
    hasApiAccess: false,
    hasUnlimitedTemplates: false,
  },
  growth: {
    emailsPerMonth: 750,
    copilots: 3,
    emailProfiles: 3,
    hasApiAccess: true,
    hasUnlimitedTemplates: true,
  },
  scale: {
    emailsPerMonth: 2000,
    copilots: Infinity,
    emailProfiles: Infinity,
    hasApiAccess: true,
    hasUnlimitedTemplates: true,
  },
};

// ─── Status mapping ────────────────────────────────────────────────────────────
function mapMollieStatus(
  mollieStatus: string,
): "active" | "canceled" | "past_due" | "trialing" | "pending" | "suspended" {
  const map: Record<string, any> = {
    active: "active",
    canceled: "canceled",
    suspended: "suspended",
    completed: "canceled",
    pending: "pending",
  };
  return map[mollieStatus] ?? "pending";
}

// ─── Auth helper ───────────────────────────────────────────────────────────────
// Billing routes can't all use requireAuth from middleware because the Mollie
// webhook is unauthenticated. This helper is used by the per-route auth checks.
async function resolveUser(
  req: Request,
  res: Response,
): Promise<typeof users.$inferSelect | null> {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const user = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .then((r) => r[0]);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  return user;
}

// ─── Validators ────────────────────────────────────────────────────────────────
const subscribeSchema = z.object({
  planId: z.enum(["starter", "growth", "scale"]),
});

// ─── Routes ────────────────────────────────────────────────────────────────────

// GET /billing/plans — public
billingRouter.get("/plans", (_req: Request, res: Response) => {
  res.json(PLANS);
});

// GET /billing/subscription
billingRouter.get(
  "/subscription",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await resolveUser(req, res);
      if (!user) return;

      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, user.id))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);

      if (!sub) {
        res.status(404).json({ error: "No subscription found" });
        return;
      }
      res.json(sub);
    } catch (err) {
      next(err);
    }
  },
);

// GET /billing/invoices
billingRouter.get(
  "/invoices",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await resolveUser(req, res);
      if (!user) return;

      const rows = await db
        .select()
        .from(invoices)
        .where(eq(invoices.userId, user.id))
        .orderBy(desc(invoices.createdAt));

      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

// POST /billing/subscribe
billingRouter.post(
  "/subscribe",
  validate(subscribeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await resolveUser(req, res);
      if (!user) return;

      const { planId } = req.body as { planId: PlanId };
      const plan = getPlan(planId)!; // schema already validated planId

      console.log(`User ${user.email} subscribing to ${planId}`);

      // Get or reuse existing Mollie customer
      let mollieCustomerId: string;
      const [existingSub] = await db
        .select({ mollieCustomerId: subscriptions.mollieCustomerId })
        .from(subscriptions)
        .where(eq(subscriptions.userId, user.id))
        .limit(1);

      if (existingSub?.mollieCustomerId) {
        mollieCustomerId = existingSub.mollieCustomerId;
      } else {
        const customer = await mollie.customers.create({
          name:
            `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() ||
            user.email,
          email: user.email,
          metadata: { userId: String(user.id), clerkId: user.clerkId },
        });
        mollieCustomerId = customer.id;
      }

      // First payment creates the mandate for future recurring charges
      const payment = await mollie.payments.create({
        amount: { currency: plan.currency, value: plan.amount },
        customerId: mollieCustomerId,
        sequenceType: SequenceType.first,
        description: `${plan.name} plan – first payment`,
        redirectUrl: `${process.env.WEBHOOK_URL}/dashboard`,
        webhookUrl: `${process.env.WEBHOOK_URL}/billing/webhook`,
        metadata: { planId, userId: String(user.id) },
      });

      console.log(
        `Mollie payment created: ${payment.id} for user ${user.email}`,
      );

      await db.transaction(async (tx) => {
        if (existingSub) {
          await tx
            .update(subscriptions)
            .set({
              planId,
              status: "pending",
              mollieCustomerId,
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.userId, user.id));
        } else {
          await tx.insert(subscriptions).values({
            userId: user.id,
            planId,
            status: "pending",
            mollieCustomerId,
          });
        }

        await tx.insert(invoices).values({
          userId: user.id,
          molliePaymentId: payment.id,
          amount: Math.round(plan.price * 100),
          currency: plan.currency.toLowerCase(),
          status: "pending",
          downloadUrl: payment.getCheckoutUrl() ?? undefined,
        });
      });

      res.json({ checkoutUrl: payment.getCheckoutUrl() });
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

  console.log(`📬 Webhook received: ${id}`);

  try {
    if (id.startsWith("tr_")) {
      const payment = await mollie.payments.get(id);
      const meta = payment.metadata as
        | { planId?: string; userId?: string }
        | undefined;
      const userId = meta?.userId ? parseInt(meta.userId) : null;
      const planId = meta?.planId;

      if (!userId || !planId) {
        console.warn("⚠️  Webhook: missing userId or planId in metadata");
        res.status(200).send("ok");
        return;
      }

      const plan = getPlan(planId);
      if (!plan) {
        console.warn(`⚠️  Webhook: unknown plan "${planId}"`);
        res.status(200).send("ok");
        return;
      }

      if (payment.status === "paid") {
        console.log(`✅ Payment successful: user=${userId} plan=${planId}`);
        await handleSuccessfulPayment(payment, userId, plan);
      } else if (["failed", "expired", "canceled"].includes(payment.status)) {
        console.log(`❌ Payment ${payment.status}: ${id}`);
        await db
          .update(invoices)
          .set({ status: "failed" })
          .where(eq(invoices.molliePaymentId, id));
      }
    } else if (id.startsWith("sub_")) {
      await handleSubscriptionWebhook(id);
    }

    // Always respond 200 to Mollie — retries happen otherwise
    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    res.status(200).send("ok");
  }
});

// POST /billing/cancel
billingRouter.post(
  "/cancel",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await resolveUser(req, res);
      if (!user) return;

      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, user.id))
        .limit(1);

      if (!sub?.mollieSubscriptionId || !sub.mollieCustomerId) {
        res.status(400).json({ error: "No active Mollie subscription found" });
        return;
      }

      await mollie.customerSubscriptions.cancel(sub.mollieSubscriptionId, {
        customerId: sub.mollieCustomerId,
      });

      await db
        .update(subscriptions)
        .set({
          cancelAtPeriodEnd: true,
          status: "canceled",
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.userId, user.id));

      res.json({ message: "Subscription canceled successfully" });
    } catch (err) {
      next(err);
    }
  },
);

// GET /billing/limits
billingRouter.get(
  "/limits",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await resolveUser(req, res);
      if (!user) return;

      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, user.id))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);

      if (!sub || sub.status !== "active") {
        res.status(200).json({
          hasActivePlan: false,
          planId: null,
          limits: null,
          usage: null,
        });
        return;
      }

      const planLimits = PLAN_LIMITS[sub.planId as PlanId];
      if (!planLimits) {
        res.status(400).json({ error: "Unknown plan" });
        return;
      }

      const now = new Date();
      const [currentUsage] = await db
        .select()
        .from(usage)
        .where(
          and(
            eq(usage.userId, user.id),
            eq(usage.subscriptionId, sub.id),
            lte(usage.periodStart, now),
            gte(usage.periodEnd, now),
          ),
        )
        .limit(1);

      const [{ copilotsCount }] = await db
        .select({ copilotsCount: count(copilots.id) })
        .from(copilots)
        .where(
          and(eq(copilots.userId, user.id), ne(copilots.status, "archived")),
        );

      const [{ emailProfilesCount }] = await db
        .select({ emailProfilesCount: count(emailProfiles.id) })
        .from(emailProfiles)
        .where(eq(emailProfiles.userId, user.id));

      const emailsSent = currentUsage?.emailsSent ?? 0;

      res.json({
        hasActivePlan: true,
        planId: sub.planId,
        periodStart: sub.currentPeriodStart,
        periodEnd: sub.currentPeriodEnd,
        limits: {
          emailsPerMonth: planLimits.emailsPerMonth,
          copilots:
            planLimits.copilots === Infinity ? null : planLimits.copilots,
          emailProfiles: planLimits.emailProfiles,
          hasApiAccess: planLimits.hasApiAccess,
          hasUnlimitedTemplates: planLimits.hasUnlimitedTemplates,
        },
        usage: {
          emailsSent,
          emailsRemaining:
            planLimits.emailsPerMonth === Infinity
              ? null
              : Math.max(0, planLimits.emailsPerMonth - emailsSent),
          emailsPercent: Math.min(
            100,
            Math.round((emailsSent / planLimits.emailsPerMonth) * 100),
          ),
          copilotsCount,
          copilotsRemaining:
            planLimits.copilots === Infinity
              ? null
              : Math.max(0, planLimits.copilots - copilotsCount),
          emailProfilesCount,
          emailProfilesRemaining: Math.max(
            0,
            planLimits.emailProfiles - emailProfilesCount,
          ),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function handleSuccessfulPayment(
  payment: any,
  userId: number,
  plan: any,
) {
  await db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);

    if (!sub) return;

    const isRecurring = !!sub.mollieSubscriptionId;

    if (isRecurring) {
      // Recurring payment: create a new invoice (already paid)
      console.log(`🔄 Recurring payment for user ${userId}, plan ${plan.id}`);
      await tx.insert(invoices).values({
        userId,
        molliePaymentId: payment.id,
        amount: Math.round(plan.price * 100),
        currency: plan.currency.toLowerCase(),
        status: "paid",
        paidAt: new Date(),
      });
    } else {
      // First payment: mark the pending invoice created during /subscribe as paid
      await tx
        .update(invoices)
        .set({ status: "paid", paidAt: new Date() })
        .where(eq(invoices.molliePaymentId, payment.id));
    }

    let mollieSubscriptionId = sub.mollieSubscriptionId;

    // Create the Mollie recurring subscription only after the first successful payment
    if (!mollieSubscriptionId && payment.customerId) {
      const mandates = await mollie.customerMandates.page({
        customerId: payment.customerId,
      });
      const validMandate = mandates.find((m: any) => m.status === "valid");

      if (validMandate) {
        const mollieSub = await mollie.customerSubscriptions.create({
          customerId: payment.customerId,
          amount: { currency: plan.currency, value: plan.amount },
          interval: plan.interval,
          description: `${plan.name} plan`,
          webhookUrl: `${process.env.WEBHOOK_URL}/billing/webhook`,
          metadata: { planId: plan.id, userId: String(userId) },
        });
        mollieSubscriptionId = mollieSub.id;
        console.log(
          `✅ Mollie subscription created: ${mollieSubscriptionId} for user ${userId}`,
        );
      }
    }

    // Renew the billing period on every successful payment (first or recurring)
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    await tx
      .update(subscriptions)
      .set({
        status: "active",
        mollieMandateId: sub.mollieMandateId || payment.mandateId,
        mollieSubscriptionId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        updatedAt: now,
      })
      .where(eq(subscriptions.userId, userId));

    // Reset usage for the new period
    await ensureUsageRecord(tx, userId, sub.id, now, periodEnd);
  });
}

async function handleSubscriptionWebhook(subscriptionId: string) {
  const [dbSub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.mollieSubscriptionId, subscriptionId))
    .limit(1);

  if (!dbSub?.mollieCustomerId) return;

  try {
    const mollieSub = await mollie.customerSubscriptions.get(subscriptionId, {
      customerId: dbSub.mollieCustomerId,
    });
    await db
      .update(subscriptions)
      .set({ status: mapMollieStatus(mollieSub.status), updatedAt: new Date() })
      .where(eq(subscriptions.mollieSubscriptionId, subscriptionId));
  } catch (err) {
    console.error(
      `Failed to fetch Mollie subscription ${subscriptionId}:`,
      err,
    );
  }
}

async function ensureUsageRecord(
  tx: any,
  userId: number,
  subscriptionId: number,
  periodStart: Date,
  periodEnd: Date,
) {
  const [existing] = await tx
    .select()
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        eq(usage.subscriptionId, subscriptionId),
        eq(usage.periodStart, periodStart),
      ),
    )
    .limit(1);

  if (existing) return existing;

  const [newUsage] = await tx
    .insert(usage)
    .values({
      userId,
      subscriptionId,
      periodStart,
      periodEnd,
      emailsSent: 0,
      copilotsCreated: 0,
      emailProfilesCreated: 0,
    })
    .returning();

  console.log(
    `✅ Created usage record for user ${userId}, period ${periodStart.toISOString()}`,
  );
  return newUsage;
}
