export type PlanId = "starter" | "growth" | "scale";
export type BillingInterval = "month" | "year";

function annualCharge(price: number) {
  return {
    price,
    amount: price.toFixed(2),
    interval: "12 months" as const,
  };
}

export const PLANS = [
  {
    id: "starter" as const,
    name: "Starter",
    price: 19,
    amount: "19.00",
    interval: "1 month",
    annual: annualCharge(179),
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
    amount: "39.00",
    interval: "1 month",
    annual: annualCharge(359),
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
    amount: "79.00",
    interval: "1 month",
    annual: annualCharge(719),
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

export const PLAN_LIMITS: Record<
  PlanId,
  {
    emailsPerMonth: number;
    copilots: number | null;
    emailAccounts: number | null;
    hasApiAccess: boolean;
    hasUnlimitedTemplates: boolean;
  }
> = {
  starter: {
    emailsPerMonth: 500,
    copilots: 1,
    emailAccounts: 1,
    hasApiAccess: false,
    hasUnlimitedTemplates: false,
  },
  growth: {
    emailsPerMonth: 1200,
    copilots: 3,
    emailAccounts: 3,
    hasApiAccess: true,
    hasUnlimitedTemplates: true,
  },
  scale: {
    emailsPerMonth: 3000,
    copilots: 8,
    emailAccounts: 5,
    hasApiAccess: true,
    hasUnlimitedTemplates: true,
  },
};

export type Plan = (typeof PLANS)[number];

export function getPlan(planId: string) {
  return PLANS.find((p) => p.id === planId) ?? null;
}

export function parseBillingInterval(value: unknown): BillingInterval {
  return value === "year" ? "year" : "month";
}

/** Mollie amount and interval for a plan at the chosen billing cadence. */
export function getPlanCharge(plan: Plan, interval: BillingInterval) {
  if (interval === "year") {
    return {
      currency: plan.currency,
      price: plan.annual.price,
      amount: plan.annual.amount,
      interval: plan.annual.interval,
    };
  }
  return {
    currency: plan.currency,
    price: plan.price,
    amount: plan.amount,
    interval: plan.interval,
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
