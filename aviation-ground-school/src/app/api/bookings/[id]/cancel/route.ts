import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { getStripe } from "@/lib/stripe";

/** POST /api/bookings/:id/cancel — student or instructor cancels; frees the slot and refunds if paid. */
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
    if (booking.status === "COMPLETED" || booking.status === "CANCELED") {
      return NextResponse.json({ error: `Booking already ${booking.status.toLowerCase()}` }, { status: 409 });
    }

    if (booking.status === "CONFIRMED" && !booking.isFreeSession && booking.priceCents > 0) {
      // Best-effort refund via the payment intent behind the completed Checkout session.
      try {
        const stripe = getStripe();
        const checkoutSession = booking.stripePaymentIntentId
          ? await stripe.checkout.sessions.retrieve(booking.stripePaymentIntentId)
          : null;
        if (checkoutSession?.payment_intent) {
          await stripe.refunds.create({ payment_intent: checkoutSession.payment_intent as string });
        }
      } catch (refundErr) {
        console.error("Refund on cancellation failed", refundErr);
      }
    }

    await prisma.$transaction([
      prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELED" } }),
      prisma.instructorSlot.update({ where: { id: booking.slotId }, data: { isBooked: false } }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
