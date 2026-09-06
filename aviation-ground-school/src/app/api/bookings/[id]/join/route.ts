import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { createJoinToken, JOIN_GRACE_MINUTES_BEFORE, JOIN_GRACE_MINUTES_AFTER } from "@/lib/video";

/**
 * GET /api/bookings/:id/join — mints a fresh, per-participant join link for a confirmed
 * booking's video room. Only available to the two participants, and only inside the join
 * window (Daily also enforces this at the room level via nbf/exp — this is just for a
 * friendlier error message before we bother minting a token).
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: { instructor: { include: { user: { select: { id: true, name: true } } } }, student: true },
    });
    if (!booking) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const isInstructor = booking.instructor.userId === user.id;
    const isStudent = booking.studentId === user.id;
    if (!isInstructor && !isStudent) {
      return NextResponse.json({ error: "Not your booking" }, { status: 403 });
    }
    if (booking.status !== "CONFIRMED") {
      return NextResponse.json({ error: `Booking is ${booking.status.toLowerCase()}, not confirmed` }, { status: 409 });
    }
    if (!booking.dailyRoomName || !booking.dailyRoomUrl) {
      return NextResponse.json({ error: "Video isn't set up for this session yet" }, { status: 409 });
    }

    const opensAt = new Date(booking.startAt.getTime() - JOIN_GRACE_MINUTES_BEFORE * 60_000);
    const closesAt = new Date(booking.endAt.getTime() + JOIN_GRACE_MINUTES_AFTER * 60_000);
    const now = new Date();
    if (now < opensAt) {
      return NextResponse.json({ error: "Too early", opensAt: opensAt.toISOString() }, { status: 409 });
    }
    if (now > closesAt) {
      return NextResponse.json({ error: "This session has ended" }, { status: 409 });
    }

    const token = await createJoinToken(booking.dailyRoomName, {
      userName: user.name,
      isOwner: isInstructor,
      exp: closesAt,
    });

    return NextResponse.json({ url: `${booking.dailyRoomUrl}?t=${token}` });
  } catch (err) {
    return apiError(err);
  }
}
