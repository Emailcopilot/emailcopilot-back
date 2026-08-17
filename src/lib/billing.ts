export type PlanId = "starter" | "growth" | "scale";

export const PLANS = [
  {
    id: "starter" as const,
    name: "Starter",
    price: 9,
    amount: "9.00",
    interval: "1 month",
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

export function getPlan(planId: string) {
  return PLANS.find((p) => p.id === planId) ?? null;
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
