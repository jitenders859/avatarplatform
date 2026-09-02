import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { getStripe } from "@/lib/stripe";

/** POST /api/bookings/:id/cancel — student or instructor cancels; refunds if it was already paid. */
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

    // Once CONFIRMED, stripePaymentIntentId has been overwritten (by the webhook) from the
    // Checkout session id to the actual PaymentIntent id, so it's directly refundable here.
    if (booking.status === "CONFIRMED" && !booking.isFreeSession && booking.priceCents > 0 && booking.stripePaymentIntentId) {
      try {
        await getStripe().refunds.create({ payment_intent: booking.stripePaymentIntentId });
      } catch (refundErr) {
        console.error("Refund on cancellation failed", refundErr);
      }
    }

    await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELED" } });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
