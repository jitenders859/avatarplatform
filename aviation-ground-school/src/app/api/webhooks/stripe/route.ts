import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { prisma } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { PLANS } from "@/lib/pricing";
import { createSessionRoom } from "@/lib/video";
import { notifyBookingConfirmed } from "@/lib/notifications";
import type { SubscriptionStatus } from "@prisma/client";

// Stripe subscription statuses -> our simplified SubscriptionStatus enum.
const STATUS_MAP: Record<Stripe.Subscription.Status, SubscriptionStatus> = {
  trialing: "TRIALING",
  active: "ACTIVE",
  past_due: "PAST_DUE",
  canceled: "CANCELED",
  unpaid: "PAST_DUE",
  incomplete: "INCOMPLETE",
  incomplete_expired: "CANCELED",
  paused: "CANCELED",
};

function planFromPriceId(priceId: string | undefined): "MONTHLY" | "ANNUAL" | undefined {
  if (priceId === PLANS.MONTHLY.stripePriceId) return "MONTHLY";
  if (priceId === PLANS.ANNUAL.stripePriceId) return "ANNUAL";
  return undefined;
}

async function syncSubscription(sub: Stripe.Subscription) {
  const userId = sub.metadata.userId;
  const priceId = sub.items.data[0]?.price.id;

  const data = {
    stripeSubscriptionId: sub.id,
    status: STATUS_MAP[sub.status],
    plan: planFromPriceId(priceId),
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };

  if (userId) {
    await prisma.subscription.upsert({
      where: { userId },
      update: data,
      create: { userId, stripeCustomerId: sub.customer as string, ...data },
    });
  } else {
    await prisma.subscription.updateMany({
      where: { stripeCustomerId: sub.customer as string },
      data,
    });
  }
}

/** POST /api/webhooks/stripe — subscription lifecycle events for the student paywall. */
export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(event.data.object as Stripe.Subscription);
      break;
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingId = session.metadata?.bookingId;
      if (session.mode === "payment" && bookingId) {
        const existing = await prisma.booking.findUnique({ where: { id: bookingId }, select: { status: true } });
        const alreadyConfirmed = existing?.status === "CONFIRMED";

        const booking = await prisma.booking.update({
          where: { id: bookingId },
          data: {
            status: "CONFIRMED",
            stripePaymentIntentId:
              typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
          },
        });

        if (!alreadyConfirmed) {
          const room = await createSessionRoom(booking.id, booking.startAt, booking.endAt).catch((err) => {
            console.error("Video room creation failed for booking", booking.id, err);
            return null;
          });
          if (room) {
            await prisma.booking.update({
              where: { id: booking.id },
              data: { dailyRoomName: room.name, dailyRoomUrl: room.url },
            });
          }
          await notifyBookingConfirmed(booking.id).catch((err) =>
            console.error("Confirmation email failed", booking.id, err)
          );
        }
      }
      break;
    }
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingId = session.metadata?.bookingId;
      if (bookingId) {
        await prisma.booking.updateMany({
          where: { id: bookingId, status: "PENDING_PAYMENT" },
          data: { status: "CANCELED" },
        });
      }
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
