import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";

/**
 * POST /api/bookings/:id/no-show — instructor-only: mark a session as a no-show once its
 * start time has passed. Doesn't touch price/payout — the instructor still gets paid for
 * showing up; this is a record-keeping status, not a refund trigger. A booking can move here
 * from CONFIRMED or from COMPLETED (the opportunistic sweep will usually have already flipped
 * it to COMPLETED by the time an instructor checks their dashboard after the session).
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
    if (booking.instructor.userId !== user.id) {
      return NextResponse.json({ error: "Only the instructor can mark a session as a no-show" }, { status: 403 });
    }
    if (booking.status !== "CONFIRMED" && booking.status !== "COMPLETED") {
      return NextResponse.json({ error: `Can't mark a ${booking.status.toLowerCase()} booking as a no-show` }, { status: 409 });
    }
    if (booking.startAt.getTime() > Date.now()) {
      return NextResponse.json({ error: "This session hasn't started yet" }, { status: 409 });
    }

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "NO_SHOW" } });
    return NextResponse.json({ booking: updated });
  } catch (err) {
    return apiError(err);
  }
}
