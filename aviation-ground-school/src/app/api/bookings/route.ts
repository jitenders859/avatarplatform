import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { getStripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { splitInstructorRate } from "@/lib/pricing";
import { hasPriorBooking } from "@/lib/instructors";
import { checkWindowAvailable } from "@/lib/availability";
import { createSessionRoom } from "@/lib/video";

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
  instructorId: z.string(),
  startAt: z.string().datetime(),
  durationMinutes: z.number().int().positive(),
});

/**
 * POST /api/bookings — book a session with an instructor at a specific start time + duration.
 *
 * The requested window is re-validated against the instructor's recurring availability and
 * existing bookings inside a transaction (serialized per-instructor via a Postgres advisory
 * lock, so two students racing for the same time can't both win). A student's first-ever
 * session with a given instructor is free up to FREE_INSTRUCTOR_SESSION_MINUTES; only the
 * minutes beyond that (or the whole session, for a repeat booking) are billed — instructor's
 * hourly rate plus the platform commission, both paid by the student in one Stripe Checkout
 * payment split via Stripe Connect. A confirmed booking gets its own Daily.co video room.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = createSchema.parse(await req.json());

    const durationMinutes = body.durationMinutes;
    if (
      durationMinutes < env.minSessionMinutes ||
      durationMinutes > env.maxSessionMinutes ||
      durationMinutes % env.sessionDurationStepMinutes !== 0
    ) {
      return NextResponse.json(
        {
          error: `Duration must be between ${env.minSessionMinutes} and ${env.maxSessionMinutes} minutes, in ${env.sessionDurationStepMinutes}-minute steps`,
        },
        { status: 400 }
      );
    }

    const startAt = new Date(body.startAt);
    if (startAt.getTime() <= Date.now() + env.minBookingNoticeMinutes * 60_000) {
      return NextResponse.json(
        { error: `Sessions must be booked at least ${env.minBookingNoticeMinutes} minutes in advance` },
        { status: 400 }
      );
    }

    const instructor = await prisma.instructor.findUnique({
      where: { id: body.instructorId },
      include: { user: { select: { name: true } }, availability: true },
    });
    if (!instructor) {
      return NextResponse.json({ error: "Instructor not found" }, { status: 404 });
    }
    if (instructor.userId === user.id) {
      return NextResponse.json({ error: "You can't book your own session" }, { status: 400 });
    }
    if (!instructor.connectOnboarded || !instructor.stripeConnectAccountId) {
      return NextResponse.json({ error: "This instructor hasn't finished payout setup yet" }, { status: 409 });
    }

    const isFirstBooking = !(await hasPriorBooking(user.id, instructor.id));
    const freeMinutes = isFirstBooking ? Math.min(durationMinutes, env.freeInstructorSessionMinutes) : 0;
    const billableMinutes = durationMinutes - freeMinutes;

    const booking = await prisma.$transaction(async (tx) => {
      // Serialize concurrent booking attempts for this instructor so two students can't
      // both claim an overlapping window between our read and our write.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${instructor.id}))`;

      const busy = await tx.booking.findMany({
        where: {
          instructorId: instructor.id,
          status: { in: ["PENDING_PAYMENT", "CONFIRMED"] },
          endAt: { gt: new Date() },
        },
        select: { startAt: true, endAt: true },
      });

      const check = checkWindowAvailable(startAt, durationMinutes, {
        timezone: instructor.timezone,
        rules: instructor.availability,
        busy,
      });
      if (!check.ok) {
        throw new BookingConflictError(check.reason);
      }

      if (billableMinutes <= 0) {
        return tx.booking.create({
          data: {
            studentId: user.id,
            instructorId: instructor.id,
            startAt,
            endAt: check.endAt,
            durationMinutes,
            isFreeSession: true,
            currency: instructor.currency,
            status: "CONFIRMED",
          },
        });
      }

      const { instructorPayoutCents, commissionCents, totalCents } = splitInstructorRate(
        instructor.hourlyRateCents,
        billableMinutes
      );

      return tx.booking.create({
        data: {
          studentId: user.id,
          instructorId: instructor.id,
          startAt,
          endAt: check.endAt,
          durationMinutes,
          isFreeSession: false,
          currency: instructor.currency,
          priceCents: totalCents,
          commissionCents,
          instructorPayoutCents,
          status: "PENDING_PAYMENT",
        },
      });
    });

    if (booking.status === "CONFIRMED") {
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
      return NextResponse.json({ booking, checkoutUrl: null }, { status: 201 });
    }

    // The booking row is already committed at this point (it had to be, to hold the window
    // under the advisory lock) — if Stripe fails here, release it rather than leaving a
    // PENDING_PAYMENT row with no checkout session blocking this time slot forever.
    try {
      const checkoutSession = await getStripe().checkout.sessions.create({
        mode: "payment",
        customer_email: user.email,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 min to pay, then the hold is released
        line_items: [
          {
            price_data: {
              currency: instructor.currency,
              unit_amount: booking.priceCents,
              product_data: {
                name: `Flight instruction with ${instructor.user.name}`,
                description: `${billableMinutes} min session on ${startAt.toISOString()}${
                  freeMinutes > 0 ? ` (first ${freeMinutes} min free)` : ""
                }`,
              },
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          application_fee_amount: booking.commissionCents,
          transfer_data: { destination: instructor.stripeConnectAccountId },
          metadata: { bookingId: booking.id },
        },
        metadata: { bookingId: booking.id },
        success_url: `${env.appUrl}/dashboard?booking=success`,
        cancel_url: `${env.appUrl}/instructors/${instructor.id}?booking=canceled`,
      });

      await prisma.booking.update({
        where: { id: booking.id },
        data: { stripePaymentIntentId: checkoutSession.id },
      });

      return NextResponse.json({ booking, checkoutUrl: checkoutSession.url }, { status: 201 });
    } catch (checkoutErr) {
      await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELED" } });
      console.error("Stripe checkout creation failed for booking", booking.id, checkoutErr);
      return NextResponse.json({ error: "Couldn't start checkout — please try again" }, { status: 502 });
    }
  } catch (err) {
    if (err instanceof BookingConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return apiError(err);
  }
}

class BookingConflictError extends Error {}
