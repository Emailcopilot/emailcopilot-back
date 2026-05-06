import { Router, Request, Response } from "express";
import { db } from "../db/drizzle";
import { subscriptions, invoices, users } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import createMollieClient, {
    MollieClient,
    SequenceType
} from "@mollie/api-client";
import { getAuth } from "@clerk/express";

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
        features: ["3 Copilots", "1 Email Profile", "500 emails/mo", "Basic templates", "Email support"],
    },
    {
        id: "growth",
        name: "Growth",
        price: 19,
        amount: "19.00",
        interval: "1 month",
        currency: "EUR",
        highlight: true,
        features: ["15 Copilots", "5 Email Profiles", "5,000 emails/mo", "Unlimited templates", "Priority support", "API access"],
    },
    {
        id: "scale",
        name: "Scale",
        price: 39,
        amount: "39.00",
        interval: "1 month",
        currency: "EUR",
        features: ["Unlimited Copilots", "20 Email Profiles", "25,000 emails/mo", "Custom templates", "Dedicated support", "API access", "Team seats"],
    },
] as const;

type PlanId = (typeof PLANS)[number]["id"];

function getPlan(planId: string) {
    return PLANS.find((p) => p.id === planId) ?? null;
}

// ─── Status Mapping ────────────────────────────────────────────────────────────
function mapMollieStatus(mollieStatus: string): "active" | "canceled" | "past_due" | "trialing" | "pending" | "suspended" {
    const map: Record<string, any> = {
        active: "active",
        canceled: "canceled",
        suspended: "suspended",
        completed: "canceled",
        pending: "pending",
    };
    return map[mollieStatus] ?? "pending";
}

// ─── Routes ────────────────────────────────────────────────────────────────────

// GET /billing/plans
billingRouter.get("/plans", (_req: Request, res: Response) => {
    res.json(PLANS);
});

// GET /billing/subscription
billingRouter.get("/subscription", async (req: Request, res: Response) => {
    try {
        const { userId } = getAuth(req)
        if (!userId) return res.status(401).json({ error: "User not found" });

        const user = await db.select().from(users).where(eq(users.clerkId, userId)).then(rows => rows[0]);


        const [sub] = await db
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.userId, user.id))
            .orderBy(desc(subscriptions.createdAt))
            .limit(1);

        if (!sub) return res.status(404).json({ error: "No subscription found" });
        res.json(sub);
    } catch (err) {
        console.error("Fetch subscription error", err);
        res.status(500).json({ error: "Failed to fetch subscription" });
    }
});

// GET /billing/invoices
billingRouter.get("/invoices", async (req: Request, res: Response) => {
    try {
        const { userId } = getAuth(req)
        if (!userId) return res.status(401).json({ error: "User not found" });

        const user = await db.select().from(users).where(eq(users.clerkId, userId)).then(rows => rows[0]);


        const rows = await db
            .select()
            .from(invoices)
            .where(eq(invoices.userId, user.id))
            .orderBy(desc(invoices.createdAt));
        res.json(rows);
    } catch (err) {
        console.error("Fetch invoices error", err);
        res.status(500).json({ error: "Failed to fetch invoices" });
    }
});

// POST /billing/subscribe
billingRouter.post("/subscribe", async (req: Request, res: Response) => {
    try {
        const { userId } = getAuth(req)
        if (!userId) return res.status(401).json({ error: "User not found" });

        const user = await db.select().from(users).where(eq(users.clerkId, userId)).then(rows => rows[0]);

        const { planId } = req.body as { planId: string };

        const plan = getPlan(planId);
        if (!plan) return res.status(400).json({ error: "Invalid planId" });

        console.log(`User ${user.email} subscribing to ${planId}`);

        // 1. Get or create Mollie Customer (idempotent)
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
                name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email,
                email: user.email,
                metadata: { userId: String(user.id), clerkId: user.clerkId },
            });
            mollieCustomerId = customer.id;
        }

        // 2. Create first payment (sequenceType: "first" creates mandate)
        const payment = await mollie.payments.create({
            amount: { currency: plan.currency, value: plan.amount },
            customerId: mollieCustomerId,
            sequenceType: SequenceType.first,
            description: `${plan.name} plan – first payment`,
            redirectUrl: `${process.env.APP_URL}/billing/subscribe/return?planId=${planId}&userId=${user.id}`,
            webhookUrl: `${process.env.APP_URL}/billing/webhook`,
            metadata: { planId, userId: String(user.id) },
        });

        console.log(`Mollie payment created: ${payment.id} for user ${user.email}`);

        // 3. Upsert pending subscription + create pending invoice (in transaction)
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
    } catch (err: any) {
        console.error("Subscribe error:", err);
        res.status(500).json({ error: "Failed to initiate subscription" });
    }
});

// GET /billing/subscribe/return
billingRouter.get("/subscribe/return", (req: Request, res: Response) => {
    const { planId } = req.query as { planId?: string };
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
    res.redirect(`${frontendUrl}/billing?plan=${planId ?? ""}&status=pending`);
});

// POST /billing/webhook
billingRouter.post("/webhook", async (req: Request, res: Response) => {
    const { id } = req.body as { id?: string };
    if (!id) return res.status(400).send("Missing id");

    try {
        // Payment webhook (first payment + recurring)
        if (id.startsWith("tr_")) {
            const payment = await mollie.payments.get(id);
            const meta = payment.metadata as { planId?: string; userId?: string } | undefined;
            const userId = meta?.userId ? parseInt(meta.userId) : null;
            const planId = meta?.planId;

            if (!userId || !planId) return res.status(200).send("ok");

            const plan = getPlan(planId);
            if (!plan) return res.status(200).send("ok");

            if (payment.status === "paid") {
                await handleSuccessfulPayment(payment, userId, plan);
            } else if (payment.status === "failed" || payment.status === "expired" || payment.status === "canceled") {
                await db
                    .update(invoices)
                    .set({ status: "failed" })
                    .where(eq(invoices.molliePaymentId, id));
            }
        }

        // Subscription webhook (recurring status changes)
        else if (id.startsWith("sub_")) {
            await handleSubscriptionWebhook(id);
        }

        res.status(200).send("ok");
    } catch (err) {
        console.error("Webhook error:", err);
        res.status(200).send("ok"); // Always acknowledge to Mollie
    }
});

// ─── Helper Functions ──────────────────────────────────────────────────────────

async function handleSuccessfulPayment(payment: any, userId: number, plan: any) {
    await db.transaction(async (tx) => {
        // Update invoice
        await tx
            .update(invoices)
            .set({ status: "paid", paidAt: new Date() })
            .where(eq(invoices.molliePaymentId, payment.id));

        // Update subscription
        const [sub] = await tx
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.userId, userId))
            .limit(1);

        if (!sub) return;

        let mollieSubscriptionId = sub.mollieSubscriptionId;

        // Create recurring subscription only once (after first successful payment)
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
                    webhookUrl: `${process.env.APP_URL}/billing/webhook`,
                    metadata: { planId: plan.id, userId: String(userId) },
                });

                mollieSubscriptionId = mollieSub.id;
            }
        }

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

        const newStatus = mapMollieStatus(mollieSub.status);

        await db
            .update(subscriptions)
            .set({ status: newStatus, updatedAt: new Date() })
            .where(eq(subscriptions.mollieSubscriptionId, subscriptionId));
    } catch (err) {
        console.error(`Failed to fetch Mollie subscription ${subscriptionId}`, err);
    }
}

// POST /billing/cancel
billingRouter.post("/cancel", async (req: Request, res: Response) => {
    try {
        const { userId } = getAuth(req)
        if (!userId) return res.status(401).json({ error: "User not found" });

        const user = await db.select().from(users).where(eq(users.clerkId, userId)).then(rows => rows[0]);


        const [sub] = await db
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.userId, user.id))
            .limit(1);

        if (!sub?.mollieSubscriptionId || !sub.mollieCustomerId) {
            return res.status(400).json({ error: "No active Mollie subscription found" });
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
        console.error("Cancel error:", err);
        res.status(500).json({ error: "Failed to cancel subscription" });
    }
});