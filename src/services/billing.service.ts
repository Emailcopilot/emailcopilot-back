import type { Request, Response } from "express";
import { db } from "../db/drizzle";
import {
  subscriptionsTable,
  invoicesTable,
  usersTable,
  usageTable,
  copilotsTable,
  emailAccountTable,
} from "../db/schema";
import { eq, desc, and, lte, gte, ne, count } from "drizzle-orm";
import createMollieClient, {
  MollieClient,
  SequenceType,
} from "@mollie/api-client";
import {
  PLANS,
  getPlan,
  getPlanLimits,
  isSubscriptionUsable,
} from "../lib/billing";
import type { SubscribeInput } from "../validators/billing.validator";

const mollie: MollieClient = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY!,
});

type DbUser = typeof usersTable.$inferSelect;

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

export function listPlans(_req: Request, res: Response) {
  res.json(
    PLANS.map((plan) => ({
      ...plan,
      maxEmailProfiles: plan.maxEmailAccounts,
    })),
  );
}

export async function getSubscription(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .orderBy(desc(subscriptionsTable.createdAt))
    .limit(1);

  if (!sub) {
    throw Object.assign(new Error("No subscription found"), { statusCode: 404 });
  }
  res.json(sub);
}

export async function listInvoices(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const rows = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.userId, userId))
    .orderBy(desc(invoicesTable.createdAt));
  res.json(rows);
}

export async function subscribe(req: Request, res: Response) {
  const user = req.dbUser! as DbUser;
  const { planId } = req.body as SubscribeInput;
  const plan = getPlan(planId)!;

  console.log(`User ${user.email} subscribing to ${planId}`);

  const [existingSub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, user.id))
    .orderBy(desc(subscriptionsTable.createdAt))
    .limit(1);

  let mollieCustomerId: string;
  if (existingSub?.mollieCustomerId) {
    mollieCustomerId = existingSub.mollieCustomerId;
  } else {
    const customer = await mollie.customers.create({
      name:
        `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email,
      email: user.email,
      metadata: { userId: String(user.id), clerkId: user.clerkId },
    });
    mollieCustomerId = customer.id;
  }

  const stillUsable = !!existingSub && isSubscriptionUsable(existingSub);

  // First payment creates the mandate for future recurring charges
  const payment = await mollie.payments.create({
    amount: { currency: plan.currency, value: plan.amount },
    customerId: mollieCustomerId,
    sequenceType: SequenceType.first,
    description: `${plan.name}`,
    redirectUrl: `${process.env.WEBHOOK_URL}/billing/subscribe/return?planId=${planId}`,
    webhookUrl: `${process.env.WEBHOOK_URL}/billing/webhook`,
    metadata: { planId, userId: String(user.id) },
  });

  console.log(`Mollie payment created: ${payment.id} for user ${user.email}`);

  await db.transaction(async (tx) => {
    let subscriptionId: number;

    if (existingSub) {
      // Keep access during plan-change checkout; apply new planId only after payment
      const [updated] = await tx
        .update(subscriptionsTable)
        .set({
          ...(stillUsable ? {} : { planId, mollieSubscriptionId: null }),
          status: stillUsable ? "active" : "pending",
          mollieCustomerId,
          cancelAtPeriodEnd: false,
          updatedAt: new Date(),
        })
        .where(eq(subscriptionsTable.userId, user.id))
        .returning({ id: subscriptionsTable.id });
      subscriptionId = updated.id;
    } else {
      const [created] = await tx
        .insert(subscriptionsTable)
        .values({
          userId: user.id,
          planId,
          status: "pending",
          mollieCustomerId,
        })
        .returning({ id: subscriptionsTable.id });
      subscriptionId = created.id;
    }

    await tx.insert(invoicesTable).values({
      userId: user.id,
      subscriptionId,
      molliePaymentId: payment.id,
      amount: Math.round(plan.price * 100),
      currency: plan.currency.toLowerCase(),
      status: "pending",
      downloadUrl: payment.getCheckoutUrl() ?? undefined,
    });
  });

  res.json({ checkoutUrl: payment.getCheckoutUrl() });
}

export function subscribeReturn(req: Request, res: Response) {
  const { planId } = req.query as { planId?: string };
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
  res.redirect(
    `${frontendUrl}/dashboard/billing?plan=${planId ?? ""}&status=pending`,
  );
}

export async function cancelSubscription(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  if (!sub?.mollieSubscriptionId || !sub.mollieCustomerId) {
    throw Object.assign(new Error("No active Mollie subscription found"), {
      statusCode: 400,
    });
  }

  // Mark cancel-at-period-end first so a racing Mollie webhook won't drop access
  await db
    .update(subscriptionsTable)
    .set({
      cancelAtPeriodEnd: true,
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.userId, userId));

  await mollie.customerSubscriptions.cancel(sub.mollieSubscriptionId, {
    customerId: sub.mollieCustomerId,
  });

  await db
    .update(subscriptionsTable)
    .set({
      mollieSubscriptionId: null,
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.userId, userId));

  res.json({
    message: "Subscription canceled successfully",
    accessUntil: sub.currentPeriodEnd,
  });
}

export async function getLimits(req: Request, res: Response) {
  const userId = req.dbUser!.id;
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .orderBy(desc(subscriptionsTable.createdAt))
    .limit(1);

  if (!sub || !isSubscriptionUsable(sub)) {
    res.json({
      hasActivePlan: false,
      planId: null,
      limits: null,
      usage: null,
    });
    return;
  }

  const planLimits = getPlanLimits(sub.planId);
  if (!planLimits) {
    throw Object.assign(new Error("Unknown plan"), { statusCode: 400 });
  }

  const now = new Date();
  const [currentUsage] = await db
    .select()
    .from(usageTable)
    .where(
      and(
        eq(usageTable.userId, userId),
        eq(usageTable.subscriptionId, sub.id),
        lte(usageTable.periodStart, now),
        gte(usageTable.periodEnd, now),
      ),
    )
    .limit(1);

  const [{ copilotsCount }] = await db
    .select({ copilotsCount: count(copilotsTable.id) })
    .from(copilotsTable)
    .where(and(eq(copilotsTable.userId, userId), ne(copilotsTable.status, "archived")));

  const [{ emailAccountsCount }] = await db
    .select({ emailAccountsCount: count(emailAccountTable.id) })
    .from(emailAccountTable)
    .where(eq(emailAccountTable.userId, userId));

  const emailsSent = currentUsage?.emailsSent ?? 0;
  const emailAccountsRemaining =
    planLimits.emailAccounts === null
      ? null
      : Math.max(0, planLimits.emailAccounts - emailAccountsCount);

  res.json({
    hasActivePlan: true,
    planId: sub.planId,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
    limits: {
      emailsPerMonth: planLimits.emailsPerMonth,
      copilots: planLimits.copilots,
      emailAccounts: planLimits.emailAccounts,
      emailProfiles: planLimits.emailAccounts,
      hasApiAccess: planLimits.hasApiAccess,
      hasUnlimitedTemplates: planLimits.hasUnlimitedTemplates,
    },
    usage: {
      emailsSent,
      emailsRemaining: Math.max(0, planLimits.emailsPerMonth - emailsSent),
      emailsPercent: Math.min(
        100,
        Math.round((emailsSent / planLimits.emailsPerMonth) * 100),
      ),
      copilotsCount,
      copilotsRemaining:
        planLimits.copilots === null
          ? null
          : Math.max(0, planLimits.copilots - copilotsCount),
      emailAccountsCount,
      emailProfilesCount: emailAccountsCount,
      emailAccountsRemaining,
      emailProfilesRemaining: emailAccountsRemaining,
    },
  });
}

/** Process a Mollie webhook payload id (`tr_…` payment or `sub_…` subscription). */
async function processWebhookPayment(id: string) {
  console.log(`📬 Webhook received: ${id}`);

  if (id.startsWith("tr_")) {
    const payment = await mollie.payments.get(id);
    const meta = payment.metadata as
      | { planId?: string; userId?: string }
      | undefined;
    const userId = meta?.userId ? parseInt(meta.userId) : null;
    const planId = meta?.planId;

    if (!userId || !planId) {
      console.warn("⚠️  Webhook: missing userId or planId in metadata");
      return;
    }

    const plan = getPlan(planId);
    if (!plan) {
      console.warn(`⚠️  Webhook: unknown plan "${planId}"`);
      return;
    }

    if (payment.status === "paid") {
      console.log(`✅ Payment successful: user=${userId} plan=${planId}`);
      await handleSuccessfulPayment(payment, userId, plan);
    } else if (["failed", "expired", "canceled"].includes(payment.status)) {
      console.log(`❌ Payment ${payment.status}: ${id}`);
      await db
        .update(invoicesTable)
        .set({ status: "failed" })
        .where(eq(invoicesTable.molliePaymentId, id));

      // Only recurring charges should mark the subscription past_due.
      // Abandoned first-payment checkouts expire/cancel without a subscriptionId.
      if (payment.subscriptionId) {
        await db
          .update(subscriptionsTable)
          .set({ status: "past_due", updatedAt: new Date() })
          .where(eq(subscriptionsTable.userId, userId));
      }
    }
  } else if (id.startsWith("sub_")) {
    await handleSubscriptionWebhook(id);
  }
}

export async function processWebhook(req: Request, res: Response) {
  const { id } = req.body as { id?: string };
  if (!id) {
    res.status(400).send("Missing id");
    return;
  }

  try {
    await processWebhookPayment(id);
    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    res.status(500).send("error");
  }
}

async function cancelMollieSubscription(customerId: string, subscriptionId: string) {
  try {
    await mollie.customerSubscriptions.cancel(subscriptionId, { customerId });
    console.log(`🛑 Canceled Mollie subscription ${subscriptionId}`);
  } catch (err) {
    console.warn(`⚠️  Could not cancel Mollie subscription ${subscriptionId}:`, err);
  }
}

/** Reuse or create a Mollie recurring sub for this plan; cancel leftover ones. */
async function ensureMollieRecurringSubscription(opts: {
  customerId: string;
  plan: NonNullable<ReturnType<typeof getPlan>>;
  userId: number;
  startDate: string;
}): Promise<string | null> {
  const { customerId, plan, userId, startDate } = opts;
  const existing = await mollie.customerSubscriptions.page({ customerId });
  const live = existing.filter(
    (s: { status: string }) => s.status === "active" || s.status === "pending",
  );
  const matching = live.find(
    (s: { amount?: { value?: string } }) => s.amount?.value === plan.amount,
  );

  if (matching) {
    for (const extra of live) {
      if (extra.id !== matching.id) {
        await cancelMollieSubscription(customerId, extra.id);
      }
    }
    return matching.id;
  }

  const mandates = await mollie.customerMandates.page({ customerId });
  const validMandate = mandates.find((m: { status: string }) => m.status === "valid");
  if (!validMandate) {
    console.warn(`⚠️  No valid mandate for customer ${customerId}; cannot create subscription`);
    return null;
  }

  const mollieSub = await mollie.customerSubscriptions.create({
    customerId,
    amount: { currency: plan.currency, value: plan.amount },
    interval: plan.interval,
    startDate,
    description: `${plan.name}`,
    webhookUrl: `${process.env.WEBHOOK_URL}/billing/webhook`,
    metadata: { planId: plan.id, userId: String(userId) },
  });
  console.log(
    `✅ Mollie subscription created: ${mollieSub.id} for user ${userId} (startDate=${startDate})`,
  );

  for (const extra of live) {
    await cancelMollieSubscription(customerId, extra.id);
  }

  return mollieSub.id;
}

async function handleSuccessfulPayment(
  payment: any,
  userId: number,
  plan: NonNullable<ReturnType<typeof getPlan>>,
) {
  await db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, userId))
      .limit(1);

    if (!sub) return;

    const [existingInvoice] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.molliePaymentId, payment.id))
      .limit(1);

    // Idempotency: same payment already fully processed → no-op on Mollie retries
    if (existingInvoice?.status === "paid" && sub.mollieSubscriptionId) {
      console.log(`⏭️  Skipping already-processed payment ${payment.id}`);
      return;
    }

    if (!existingInvoice) {
      console.log(`🔄 Recording payment for user ${userId}, plan ${plan.id}`);
      await tx.insert(invoicesTable).values({
        userId,
        subscriptionId: sub.id,
        molliePaymentId: payment.id,
        amount: Math.round(plan.price * 100),
        currency: plan.currency.toLowerCase(),
        status: "paid",
        paidAt: new Date(),
      });
    } else if (existingInvoice.status !== "paid") {
      // First payment: mark the pending invoice created during /subscribe as paid
      await tx
        .update(invoicesTable)
        .set({
          status: "paid",
          paidAt: new Date(),
          subscriptionId: sub.id,
        })
        .where(eq(invoicesTable.molliePaymentId, payment.id));
    }

    // Renew the billing period on every successful payment (first or recurring)
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    let mollieSubscriptionId = sub.mollieSubscriptionId;
    if (payment.customerId) {
      const ensured = await ensureMollieRecurringSubscription({
        customerId: payment.customerId,
        plan,
        userId,
        startDate: periodEnd.toISOString().slice(0, 10),
      });
      if (ensured) mollieSubscriptionId = ensured;
    }

    await tx
      .update(subscriptionsTable)
      .set({
        planId: plan.id,
        status: "active",
        mollieMandateId: sub.mollieMandateId || payment.mandateId,
        mollieSubscriptionId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        updatedAt: now,
      })
      .where(eq(subscriptionsTable.userId, userId));

    // Reset usage for the new period
    await ensureUsageRecord(tx, userId, sub.id, now, periodEnd);
  });
}

async function handleSubscriptionWebhook(subscriptionId: string) {
  const [dbSub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.mollieSubscriptionId, subscriptionId))
    .limit(1);

  // Local cancel clears mollieSubscriptionId; ignore late Mollie cancel webhooks
  if (!dbSub?.mollieCustomerId) {
    console.log(
      `⏭️  Ignoring subscription webhook ${subscriptionId} (no local match)`,
    );
    return;
  }

  try {
    const mollieSub = await mollie.customerSubscriptions.get(subscriptionId, {
      customerId: dbSub.mollieCustomerId,
    });
    const mapped = mapMollieStatus(mollieSub.status);
    const periodValid =
      !!dbSub.currentPeriodEnd && dbSub.currentPeriodEnd >= new Date();

    // Future-dated Mollie subs stay "pending" until startDate; the first
    // period is already paid so local access must remain active.
    if (mapped === "pending" && periodValid) {
      if (dbSub.status !== "active") {
        await db
          .update(subscriptionsTable)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(subscriptionsTable.id, dbSub.id));
      }
      return;
    }

    // User canceled at period end: keep active until currentPeriodEnd
    if (mapped === "canceled" && dbSub.cancelAtPeriodEnd && periodValid) {
      return;
    }

    await db
      .update(subscriptionsTable)
      .set({ status: mapped, updatedAt: new Date() })
      .where(eq(subscriptionsTable.id, dbSub.id));
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
    .from(usageTable)
    .where(
      and(
        eq(usageTable.userId, userId),
        eq(usageTable.subscriptionId, subscriptionId),
        eq(usageTable.periodStart, periodStart),
      ),
    )
    .limit(1);

  if (existing) return existing;

  const [newUsage] = await tx
    .insert(usageTable)
    .values({
      userId,
      subscriptionId,
      periodStart,
      periodEnd,
      emailsSent: 0,
      copilotsCreated: 0,
      emailAccountsCreated: 0,
    })
    .returning();

  console.log(
    `✅ Created usage record for user ${userId}, period ${periodStart.toISOString()}`,
  );
  return newUsage;
}
