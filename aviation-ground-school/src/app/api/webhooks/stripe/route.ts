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
        const paymentIntentId =
          typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;

        // Conditional update, not a blind write: only transitions a booking that's still
        // PENDING_PAYMENT. If the student canceled (or the hold expired) between opening
        // Checkout and paying, this booking is CANCELED by now and its window may already be
        // rebooked by someone else — confirming it anyway would silently double-book that
        // slot. Postgres serializes concurrent updates to the same row, so this is race-safe
        // without needing the advisory lock booking creation/cancel/reschedule use.
        const claim = await prisma.booking.updateMany({
          where: { id: bookingId, status: "PENDING_PAYMENT" },
          data: { status: "CONFIRMED", stripePaymentIntentId: paymentIntentId },
        });

        if (claim.count === 1) {
          const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
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
        } else {
          const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
          if (booking && booking.status !== "CONFIRMED" && paymentIntentId) {
            // Genuinely orphaned payment: it landed on a booking that's CANCELED (or some
            // other terminal state), not a benign webhook retry after our own success.
            console.error(
              `Payment succeeded for booking ${bookingId} which is ${booking.status}, not PENDING_PAYMENT — refunding`
            );
            try {
              await getStripe().refunds.create({ payment_intent: paymentIntentId });
              await prisma.booking.update({
                where: { id: bookingId },
                data: {
                  paymentIssueAt: new Date(),
                  paymentIssueNote: `Payment landed after booking was ${booking.status} — auto-refunded`,
                },
              });
            } catch (refundErr) {
              console.error("Auto-refund for orphaned payment failed", bookingId, refundErr);
              await prisma.booking.update({
                where: { id: bookingId },
                data: {
                  paymentIssueAt: new Date(),
                  paymentIssueNote: `Payment landed after booking was ${booking.status} — auto-refund FAILED, needs manual refund`,
                },
              });
            }
          }
          // booking.status === "CONFIRMED" already: a benign retry of a webhook we already
          // handled successfully — nothing to do.
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
    case "charge.refunded": {
      // An out-of-band refund (issued from the Stripe dashboard, say) rather than one this
      // app initiated — keep the booking's status honest either way.
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (paymentIntentId) {
        const booking = await prisma.booking.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
        if (booking && booking.status !== "CANCELED") {
          await prisma.booking.update({
            where: { id: booking.id },
            data: {
              status: "CANCELED",
              paymentIssueAt: new Date(),
              paymentIssueNote: "Refunded out-of-band via Stripe (not through the app's cancel flow)",
            },
          });
          console.warn(`Booking ${booking.id} canceled — refunded out-of-band via Stripe`);
        }
      }
      break;
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      const paymentIntentId =
        typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
      if (paymentIntentId) {
        const booking = await prisma.booking.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
        if (booking) {
          console.error(`DISPUTE opened on booking ${booking.id} (payment_intent ${paymentIntentId}) — needs manual review`);
          await prisma.booking.update({
            where: { id: booking.id },
            data: {
              status: "CANCELED",
              paymentIssueAt: new Date(),
              paymentIssueNote: "Stripe dispute opened — needs manual review",
            },
          });
        }
      }
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
