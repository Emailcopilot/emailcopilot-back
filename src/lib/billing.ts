export type PlanId = "starter" | "growth" | "scale";
export type BillingInterval = "month" | "year";

export const PLANS = [
  {
    id: "starter" as const,
    name: "Starter",
    price: 19,
    annualPrice: 179,
    currency: "EUR",
    maxEmailsPerMonth: 500,
    maxCopilots: 1,
    maxEmailAccounts: 1,
    features: [
      "1 Copilot",
      "1 email account",
      "500 emails/month",
      "CSV export",
      "Email support",
    ],
  },
  {
    id: "growth" as const,
    name: "Growth",
    price: 39,
    annualPrice: 359,
    currency: "EUR",
    maxEmailsPerMonth: 1200,
    maxCopilots: 3,
    maxEmailAccounts: 3,
    highlight: true,
    features: [
      "3 Copilots",
      "3 email accounts",
      "1,200 emails/month",
      "CSV export",
      "Email support",
    ],
  },
  {
    id: "scale" as const,
    name: "Scale",
    price: 79,
    annualPrice: 719,
    currency: "EUR",
    maxEmailsPerMonth: 3000,
    maxCopilots: 8,
    maxEmailAccounts: 5,
    features: [
      "8 Copilots",
      "5 email accounts",
      "3,000 emails/month",
      "CSV export",
      "Priority support",
    ],
  },
];

type PlanLimits = {
  emailsPerMonth: number;
  copilots: number | null;
  emailAccounts: number | null;
};

export const PLAN_LIMITS = Object.fromEntries(
  PLANS.map((plan) => [
    plan.id,
    {
      emailsPerMonth: plan.maxEmailsPerMonth,
      copilots: plan.maxCopilots,
      emailAccounts: plan.maxEmailAccounts,
    },
  ]),
) as Record<PlanId, PlanLimits>;

export type Plan = (typeof PLANS)[number];

export function getPlan(planId: string) {
  return PLANS.find((p) => p.id === planId) ?? null;
}

export function parseBillingInterval(value: unknown): BillingInterval {
  return value === "year" ? "year" : "month";
}

/** Mollie amount and interval for a plan at the chosen billing cadence. */
export function getPlanCharge(plan: Plan, interval: BillingInterval) {
  const price = interval === "year" ? plan.annualPrice : plan.price;
  return {
    currency: plan.currency,
    price,
    amount: price.toFixed(2),
    interval: interval === "year" ? "12 months" : "1 month",
  };
}

export function chargeDescription(planName: string, interval: BillingInterval) {
  return interval === "year" ? `${planName} (annual)` : planName;
}

export function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

/**
 * Month-sized usage window that contains `now`, stepped from the billing anchor.
 * Email quotas stay monthly even when the subscription is billed annually.
 */
export function monthlyUsageWindow(anchor: Date, now: Date) {
  let periodStart = new Date(anchor);
  let periodEnd = addMonths(periodStart, 1);
  while (now > periodEnd) {
    periodStart = periodEnd;
    periodEnd = addMonths(periodStart, 1);
  }
  return { periodStart, periodEnd };
}

export function getPlanLimits(planId: string) {
  return PLAN_LIMITS[planId as PlanId] ?? null;
}

/** Access is allowed while status is active and the paid period has not ended. */
export function isSubscriptionUsable(sub: {
  status: string;
  currentPeriodEnd: Date | null;
}): boolean {
  if (sub.status !== "active") return false;
  if (sub.currentPeriodEnd && sub.currentPeriodEnd < new Date()) return false;
  return true;
}
