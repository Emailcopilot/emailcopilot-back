export type PlanId = "starter" | "growth" | "scale";
export type BillingInterval = "month" | "year";

/** Annual checkout is one charge of monthly × 12 × 0.8 (save 20%). */
const ANNUAL_DISCOUNT = 0.8;

function annualCharge(monthlyPrice: number) {
  const price = Math.round(monthlyPrice * 12 * ANNUAL_DISCOUNT * 100) / 100;
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
    price: 9,
    amount: "9.00",
    interval: "1 month",
    annual: annualCharge(9),
    currency: "EUR",
    maxEmailsPerMonth: 250,
    maxCopilots: 1,
    maxEmailAccounts: 1,
    features: [
      "1 Copilots",
      "1 SMTP account",
      "250 emails (~8/day)",
      "Standard delivery speed",
      "No data export",
    ],
  },
  {
    id: "growth" as const,
    name: "Growth",
    price: 19,
    amount: "19.00",
    interval: "1 month",
    annual: annualCharge(19),
    currency: "EUR",
    maxEmailsPerMonth: 750,
    maxCopilots: 3,
    maxEmailAccounts: 3,
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
    id: "scale" as const,
    name: "Scale",
    price: 39,
    amount: "39.00",
    interval: "1 month",
    annual: annualCharge(39),
    currency: "EUR",
    maxEmailsPerMonth: 2000,
    maxCopilots: null as number | null, // unlimited
    maxEmailAccounts: null as number | null, // unlimited
    features: [
      "Unlimited Copilots",
      "Unlimited SMTP accounts",
      "2000 emails (~65/day)",
      "Priority delivery speed",
      "Full data export",
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
    emailsPerMonth: 250,
    copilots: 1,
    emailAccounts: 1,
    hasApiAccess: false,
    hasUnlimitedTemplates: false,
  },
  growth: {
    emailsPerMonth: 750,
    copilots: 3,
    emailAccounts: 3,
    hasApiAccess: true,
    hasUnlimitedTemplates: true,
  },
  scale: {
    emailsPerMonth: 2000,
    copilots: null,
    emailAccounts: null,
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
