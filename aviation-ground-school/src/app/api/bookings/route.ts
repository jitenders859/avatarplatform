import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { getStripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { splitInstructorRate } from "@/lib/pricing";
import { hasPriorBooking } from "@/lib/instructors";

/** GET /api/bookings — the current user's bookings, as a student and/or as an instructor. */
export async function GET() {
  try {
    const user = await requireUser();
    const [asStudent, asInstructor] = await Promise.all([
      prisma.booking.findMany({
        where: { studentId: user.id },
        include: { instructor: { include: { user: { select: { name: true } } } } },
        orderBy: { startAt: "desc" },
      }),
      user.instructor
        ? prisma.booking.findMany({
            where: { instructorId: user.instructor.id },
            include: { student: { select: { name: true, email: true } } },
            orderBy: { startAt: "desc" },
          })
        : Promise.resolve([]),
    ]);

    return NextResponse.json({ asStudent, asInstructor });
  } catch (err) {
    return apiError(err);
  }
}

const createSchema = z.object({
  slotId: z.string(),
});

/**
 * POST /api/bookings — book a slot with an instructor.
 *
 * A student's first-ever session with a given instructor is free up to
 * FREE_INSTRUCTOR_SESSION_MINUTES; only the minutes beyond that (or the whole session, for a
 * repeat booking) are billed — instructor's hourly rate plus the platform commission, both
 * paid by the student in one Stripe Checkout payment that's split via Stripe Connect.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { slotId } = createSchema.parse(await req.json());

    const slot = await prisma.instructorSlot.findUnique({
      where: { id: slotId },
      include: { instructor: { include: { user: { select: { name: true } } } } },
    });
    if (!slot || slot.isBooked) {
      return NextResponse.json({ error: "That slot is no longer available" }, { status: 409 });
    }
    if (slot.startAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: "That slot is in the past" }, { status: 400 });
    }
    if (slot.instructor.userId === user.id) {
      return NextResponse.json({ error: "You can't book your own slot" }, { status: 400 });
    }
    if (!slot.instructor.connectOnboarded || !slot.instructor.stripeConnectAccountId) {
      return NextResponse.json({ error: "This instructor hasn't finished payout setup yet" }, { status: 409 });
    }

    // Claim the slot atomically so two students can't both book it.
    const claim = await prisma.instructorSlot.updateMany({
      where: { id: slotId, isBooked: false },
      data: { isBooked: true },
    });
    if (claim.count === 0) {
      return NextResponse.json({ error: "That slot is no longer available" }, { status: 409 });
    }

    const durationMinutes = Math.round((slot.endAt.getTime() - slot.startAt.getTime()) / 60_000);
    const isFirstBooking = !(await hasPriorBooking(user.id, slot.instructor.id));
    const freeMinutes = isFirstBooking ? Math.min(durationMinutes, env.freeInstructorSessionMinutes) : 0;
    const billableMinutes = durationMinutes - freeMinutes;

    if (billableMinutes <= 0) {
      const booking = await prisma.booking.create({
        data: {
          studentId: user.id,
          instructorId: slot.instructor.id,
          slotId: slot.id,
          startAt: slot.startAt,
          endAt: slot.endAt,
          isFreeSession: true,
          currency: slot.instructor.currency,
          status: "CONFIRMED",
        },
      });
      return NextResponse.json({ booking, checkoutUrl: null }, { status: 201 });
    }

    const { instructorPayoutCents, commissionCents, totalCents } = splitInstructorRate(
      slot.instructor.hourlyRateCents,
      billableMinutes
    );

    const booking = await prisma.booking.create({
      data: {
        studentId: user.id,
        instructorId: slot.instructor.id,
        slotId: slot.id,
        startAt: slot.startAt,
        endAt: slot.endAt,
        isFreeSession: false,
        currency: slot.instructor.currency,
        priceCents: totalCents,
        commissionCents,
        instructorPayoutCents,
        status: "PENDING_PAYMENT",
      },
    });

    const checkoutSession = await getStripe().checkout.sessions.create({
      mode: "payment",
      customer_email: user.email,
      line_items: [
        {
          price_data: {
            currency: slot.instructor.currency,
            unit_amount: totalCents,
            product_data: {
              name: `Flight instruction with ${slot.instructor.user.name}`,
              description: `${billableMinutes} min session on ${slot.startAt.toISOString()}${
                freeMinutes > 0 ? ` (first ${freeMinutes} min free)` : ""
              }`,
            },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: commissionCents,
        transfer_data: { destination: slot.instructor.stripeConnectAccountId },
        metadata: { bookingId: booking.id },
      },
      metadata: { bookingId: booking.id },
      success_url: `${env.appUrl}/dashboard?booking=success`,
      cancel_url: `${env.appUrl}/instructors/${slot.instructor.id}?booking=canceled`,
    });

    await prisma.booking.update({
      where: { id: booking.id },
      data: { stripePaymentIntentId: checkoutSession.id },
    });

    return NextResponse.json({ booking, checkoutUrl: checkoutSession.url }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
