import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { prisma } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { env } from "@/lib/env";

/**
 * POST /api/webhooks/stripe-connect — events on instructors' *connected* accounts.
 * This is a separate webhook endpoint/secret from /api/webhooks/stripe: configure it in
 * the Stripe dashboard with "Listen to events on Connected accounts" enabled.
 */
export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, env.stripeConnectWebhookSecret);
  } catch (err) {
    console.error("Stripe Connect webhook signature verification failed", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const readyForPayouts = Boolean(account.charges_enabled && account.payouts_enabled);

    await prisma.instructor.updateMany({
      where: { stripeConnectAccountId: account.id },
      data: { connectOnboarded: readyForPayouts },
    });
  }

  return NextResponse.json({ received: true });
}
