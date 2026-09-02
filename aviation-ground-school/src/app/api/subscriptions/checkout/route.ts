import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { getStripe } from "@/lib/stripe";
import { PLANS, PlanKey } from "@/lib/pricing";
import { env } from "@/lib/env";

const bodySchema = z.object({
  plan: z.enum(["MONTHLY", "ANNUAL"]),
});

/** POST /api/subscriptions/checkout — create a Stripe Checkout session for the paywall plan. */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { plan } = bodySchema.parse(await req.json()) as { plan: PlanKey };
    const stripe = getStripe();

    let stripeCustomerId = user.subscription?.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user.id },
      });
      stripeCustomerId = customer.id;
      await prisma.subscription.upsert({
        where: { userId: user.id },
        update: { stripeCustomerId },
        create: { userId: user.id, stripeCustomerId },
      });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: PLANS[plan].stripePriceId, quantity: 1 }],
      success_url: `${env.appUrl}/dashboard?checkout=success`,
      cancel_url: `${env.appUrl}/pricing?checkout=canceled`,
      metadata: { userId: user.id, plan },
      subscription_data: { metadata: { userId: user.id, plan } },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    return apiError(err);
  }
}
