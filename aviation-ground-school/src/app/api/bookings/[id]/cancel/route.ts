import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { getStripe } from "@/lib/stripe";

const CANCELABLE_STATUSES = ["PENDING_PAYMENT", "CONFIRMED"] as const;

/**
 * POST /api/bookings/:id/cancel — student or instructor cancels; refunds if it was already
 * paid. Takes the same per-instructor advisory lock booking/reschedule use, and re-checks
 * the booking's status *after* acquiring it (not just once, up front) via a conditional
 * update — otherwise this could race a concurrent reschedule (whichever writes last wins
 * silently) or, if it read stale data, cancel a booking that already moved on.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: { instructor: true },
    });
    if (!booking) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (booking.studentId !== user.id && booking.instructor.userId !== user.id) {
      return NextResponse.json({ error: "Not your booking" }, { status: 403 });
    }

    const wasConfirmedAndPaid = booking.status === "CONFIRMED" && !booking.isFreeSession && booking.priceCents > 0;

    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.instructorId}))`;
      const result = await tx.booking.updateMany({
        where: { id: booking.id, status: { in: [...CANCELABLE_STATUSES] } },
        data: { status: "CANCELED" },
      });
      return result.count === 1;
    });

    if (!claimed) {
      const fresh = await prisma.booking.findUnique({ where: { id: booking.id }, select: { status: true } });
      return NextResponse.json(
        { error: `Booking is already ${fresh?.status.toLowerCase() ?? "in a state that can't be canceled"}` },
        { status: 409 }
      );
    }

    // Once CONFIRMED, stripePaymentIntentId has been overwritten (by the webhook) from the
    // Checkout session id to the actual PaymentIntent id, so it's directly refundable here.
    // Done after the status transaction commits — no reason to hold the advisory lock open
    // across a slow network call to Stripe.
    if (wasConfirmedAndPaid && booking.stripePaymentIntentId) {
      try {
        await getStripe().refunds.create({ payment_intent: booking.stripePaymentIntentId });
      } catch (refundErr) {
        console.error("Refund on cancellation failed", booking.id, refundErr);
        await prisma.booking.update({
          where: { id: booking.id },
          data: { paymentIssueAt: new Date(), paymentIssueNote: "Refund on cancellation failed — see server logs" },
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
