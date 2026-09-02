import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { env } from "@/lib/env";
import { checkWindowAvailable } from "@/lib/availability";
import { updateSessionRoomWindow } from "@/lib/video";

const bodySchema = z.object({ startAt: z.string().datetime() });

/**
 * POST /api/bookings/:id/reschedule — student-only: move a confirmed booking to a new start
 * time, same duration and price. The instructor's remedy for "I can't make it" stays
 * cancellation (which refunds); this just moves the clock for the student's own scheduling
 * conflicts. Revalidated against the instructor's availability exactly like a fresh booking.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const { startAt: startAtRaw } = bodySchema.parse(await req.json());
    const startAt = new Date(startAtRaw);

    if (startAt.getTime() <= Date.now() + env.minBookingNoticeMinutes * 60_000) {
      return NextResponse.json(
        { error: `Sessions must be booked at least ${env.minBookingNoticeMinutes} minutes in advance` },
        { status: 400 }
      );
    }

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: { instructor: { include: { availability: true } } },
    });
    if (!booking) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (booking.studentId !== user.id) {
      return NextResponse.json({ error: "Only the student can reschedule a booking" }, { status: 403 });
    }
    if (booking.status !== "CONFIRMED") {
      return NextResponse.json({ error: `Can't reschedule a ${booking.status.toLowerCase()} booking` }, { status: 409 });
    }
    if (booking.startAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: "This session has already started" }, { status: 409 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.instructorId}))`;

      const busy = await tx.booking.findMany({
        where: {
          instructorId: booking.instructorId,
          id: { not: booking.id },
          status: { in: ["PENDING_PAYMENT", "CONFIRMED"] },
          endAt: { gt: new Date() },
        },
        select: { startAt: true, endAt: true },
      });

      const check = checkWindowAvailable(startAt, booking.durationMinutes, {
        timezone: booking.instructor.timezone,
        rules: booking.instructor.availability,
        busy,
      });
      if (!check.ok) {
        throw new RescheduleConflictError(check.reason);
      }

      return tx.booking.update({
        where: { id: booking.id },
        data: { startAt, endAt: check.endAt, reminderSentAt: null },
      });
    });

    if (booking.dailyRoomName) {
      await updateSessionRoomWindow(booking.dailyRoomName, updated.startAt, updated.endAt).catch((err) =>
        console.error("Failed to move video room window for booking", booking.id, err)
      );
    }

    return NextResponse.json({ booking: updated });
  } catch (err) {
    if (err instanceof RescheduleConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return apiError(err);
  }
}

class RescheduleConflictError extends Error {}
