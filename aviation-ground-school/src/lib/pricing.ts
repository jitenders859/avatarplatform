import { env } from "@/lib/env";
import type { Subscription } from "@prisma/client";

/** A subscription unlocks unlimited chatbot access while it's ACTIVE/TRIALING and unexpired. */
export function isSubscriptionActive(subscription: Subscription | null | undefined): boolean {
  if (!subscription) return false;
  if (subscription.status !== "ACTIVE" && subscription.status !== "TRIALING") return false;
  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd.getTime() < Date.now()) return false;
  return true;
}

export const PLANS = {
  MONTHLY: {
    key: "MONTHLY" as const,
    label: "Monthly",
    get stripePriceId() {
      return env.stripePriceMonthly;
    },
  },
  ANNUAL: {
    key: "ANNUAL" as const,
    label: "Annual",
    get stripePriceId() {
      return env.stripePriceAnnual;
    },
  },
};

export type PlanKey = keyof typeof PLANS;

/** Splits an instructor session price into (instructor payout, platform commission). */
export function splitInstructorRate(hourlyRateCents: number, minutes: number) {
  const baseCents = Math.round((hourlyRateCents * minutes) / 60);
  const commissionCents = Math.round((baseCents * env.platformCommissionBps) / 10_000);
  const totalCents = baseCents + commissionCents;
  return {
    instructorPayoutCents: baseCents,
    commissionCents,
    totalCents,
  };
}
