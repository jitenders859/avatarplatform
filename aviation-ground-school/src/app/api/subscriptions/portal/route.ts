import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { getStripe } from "@/lib/stripe";
import { env } from "@/lib/env";

/** POST /api/subscriptions/portal — hand the student a Stripe Billing Portal link to manage/cancel. */
export async function POST() {
  try {
    const user = await requireUser();
    if (!user.subscription?.stripeCustomerId) {
      return NextResponse.json({ error: "No billing account yet" }, { status: 404 });
    }

    const portalSession = await getStripe().billingPortal.sessions.create({
      customer: user.subscription.stripeCustomerId,
      return_url: `${env.appUrl}/dashboard`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (err) {
    return apiError(err);
  }
}
