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

type DbUser = typeof users.$inferSelect;

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

export function listPlans() {
  return PLANS;
}

export async function getSubscription(userId: number) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  if (!sub) {
    throw Object.assign(new Error("No subscription found"), { statusCode: 404 });
  }
  return sub;
}

export async function listInvoices(userId: number) {
  return db
    .select()
    .from(invoices)
    .where(eq(invoices.userId, userId))
    .orderBy(desc(invoices.createdAt));
}

export async function subscribe(user: DbUser, { planId }: SubscribeInput) {
  const plan = getPlan(planId)!;

  console.log(`User ${user.email} subscribing to ${planId}`);

  const [existingSub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  // Cancel any existing Mollie subscription so plan changes don't double-charge
  if (existingSub?.mollieSubscriptionId && existingSub.mollieCustomerId) {
    try {
      await mollie.customerSubscriptions.cancel(
        existingSub.mollieSubscriptionId,
        { customerId: existingSub.mollieCustomerId },
      );
      console.log(
        `🛑 Canceled previous Mollie subscription ${existingSub.mollieSubscriptionId}`,
      );
    } catch (err) {
      console.warn(`⚠️  Could not cancel previous Mollie subscription:`, err);
    }
  }

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
    description: `${plan.name} plan – first payment`,
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
        .update(subscriptions)
        .set({
          ...(stillUsable ? {} : { planId }),
          status: stillUsable ? "active" : "pending",
          mollieCustomerId,
          mollieSubscriptionId: null,
          cancelAtPeriodEnd: false,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.userId, user.id))
        .returning({ id: subscriptions.id });
      subscriptionId = updated.id;
    } else {
      const [created] = await tx
        .insert(subscriptions)
        .values({
          userId: user.id,
          planId,
          status: "pending",
          mollieCustomerId,
        })
        .returning({ id: subscriptions.id });
      subscriptionId = created.id;
    }

    await tx.insert(invoices).values({
      userId: user.id,
      subscriptionId,
      molliePaymentId: payment.id,
      amount: Math.round(plan.price * 100),
      currency: plan.currency.toLowerCase(),
      status: "pending",
      downloadUrl: payment.getCheckoutUrl() ?? undefined,
    });
  });

  return { checkoutUrl: payment.getCheckoutUrl() };
}

export async function cancelSubscription(userId: number) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  if (!sub?.mollieSubscriptionId || !sub.mollieCustomerId) {
    throw Object.assign(new Error("No active Mollie subscription found"), {
      statusCode: 400,
    });
  }

  // Mark cancel-at-period-end first so a racing Mollie webhook won't drop access
  await db
    .update(subscriptions)
    .set({
      cancelAtPeriodEnd: true,
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId));

  await mollie.customerSubscriptions.cancel(sub.mollieSubscriptionId, {
    customerId: sub.mollieCustomerId,
  });

  await db
    .update(subscriptions)
    .set({
      mollieSubscriptionId: null,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId));

  return {
    message: "Subscription canceled successfully",
    accessUntil: sub.currentPeriodEnd,
  };
}

export async function getLimits(userId: number) {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  if (!sub || !isSubscriptionUsable(sub)) {
    return {
      hasActivePlan: false,
      planId: null,
      limits: null,
      usage: null,
    };
  }

  const planLimits = getPlanLimits(sub.planId);
  if (!planLimits) {
    throw Object.assign(new Error("Unknown plan"), { statusCode: 400 });
  }

  const now = new Date();
  const [currentUsage] = await db
    .select()
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        eq(usage.subscriptionId, sub.id),
        lte(usage.periodStart, now),
        gte(usage.periodEnd, now),
      ),
    )
    .limit(1);

  const [{ copilotsCount }] = await db
    .select({ copilotsCount: count(copilots.id) })
    .from(copilots)
    .where(and(eq(copilots.userId, userId), ne(copilots.status, "archived")));

  const [{ emailProfilesCount }] = await db
    .select({ emailProfilesCount: count(emailProfiles.id) })
    .from(emailProfiles)
    .where(eq(emailProfiles.userId, userId));

  const emailsSent = currentUsage?.emailsSent ?? 0;

  return {
    hasActivePlan: true,
    planId: sub.planId,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
    limits: {
      emailsPerMonth: planLimits.emailsPerMonth,
      copilots: planLimits.copilots,
      emailProfiles: planLimits.emailProfiles,
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
      emailProfilesCount,
      emailProfilesRemaining:
        planLimits.emailProfiles === null
          ? null
          : Math.max(0, planLimits.emailProfiles - emailProfilesCount),
    },
  };
}

/** Process a Mollie webhook payload id (`tr_…` payment or `sub_…` subscription). */
export async function processWebhook(id: string) {
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
        .update(invoices)
        .set({ status: "failed" })
        .where(eq(invoices.molliePaymentId, id));

      // Recurring charge failed → mark subscription past_due
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .limit(1);
      if (sub?.mollieSubscriptionId) {
        await db
          .update(subscriptions)
          .set({ status: "past_due", updatedAt: new Date() })
          .where(eq(subscriptions.userId, userId));
      }
    }
  } else if (id.startsWith("sub_")) {
    await handleSubscriptionWebhook(id);
  }
}

async function handleSuccessfulPayment(
  payment: any,
  userId: number,
  plan: NonNullable<ReturnType<typeof getPlan>>,
) {
  await db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);

    if (!sub) return;

    const [existingInvoice] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.molliePaymentId, payment.id))
      .limit(1);

    // Idempotency: same payment already fully processed → no-op on Mollie retries
    if (existingInvoice?.status === "paid" && sub.mollieSubscriptionId) {
      console.log(`⏭️  Skipping already-processed payment ${payment.id}`);
      return;
    }

    if (!existingInvoice) {
      console.log(`🔄 Recording payment for user ${userId}, plan ${plan.id}`);
      await tx.insert(invoices).values({
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
        .update(invoices)
        .set({
          status: "paid",
          paidAt: new Date(),
          subscriptionId: sub.id,
        })
        .where(eq(invoices.molliePaymentId, payment.id));
    }

    let mollieSubscriptionId = sub.mollieSubscriptionId;

    // Renew the billing period on every successful payment (first or recurring)
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    // Create the Mollie recurring subscription only after the first successful payment.
    // startDate is set to periodEnd so the first payment covers the current month
    // and Mollie does not charge again immediately.
    if (!mollieSubscriptionId && payment.customerId) {
      // Reuse an existing Mollie sub if a prior attempt created one but DB didn't persist it
      const existingMollieSubs = await mollie.customerSubscriptions.page({
        customerId: payment.customerId,
      });
      const reusable = existingMollieSubs.find(
        (s: any) => s.status === "active" || s.status === "pending",
      );

      if (reusable) {
        mollieSubscriptionId = reusable.id;
        console.log(
          `♻️  Reusing existing Mollie subscription ${mollieSubscriptionId} for user ${userId}`,
        );
      } else {
        const mandates = await mollie.customerMandates.page({
          customerId: payment.customerId,
        });
        const validMandate = mandates.find((m: any) => m.status === "valid");

        if (validMandate) {
          const startDate = periodEnd.toISOString().slice(0, 10);
          const mollieSub = await mollie.customerSubscriptions.create({
            customerId: payment.customerId,
            amount: { currency: plan.currency, value: plan.amount },
            interval: plan.interval,
            startDate,
            description: `${plan.name} plan`,
            webhookUrl: `${process.env.WEBHOOK_URL}/billing/webhook`,
            metadata: { planId: plan.id, userId: String(userId) },
          });
          mollieSubscriptionId = mollieSub.id;
          console.log(
            `✅ Mollie subscription created: ${mollieSubscriptionId} for user ${userId} (startDate=${startDate})`,
          );
        }
      }
    }

    await tx
      .update(subscriptions)
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

    // User canceled at period end: keep active until currentPeriodEnd
    if (
      mapped === "canceled" &&
      dbSub.cancelAtPeriodEnd &&
      dbSub.currentPeriodEnd &&
      dbSub.currentPeriodEnd >= new Date()
    ) {
      return;
    }

    await db
      .update(subscriptions)
      .set({ status: mapped, updatedAt: new Date() })
      .where(eq(subscriptions.id, dbSub.id));
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
