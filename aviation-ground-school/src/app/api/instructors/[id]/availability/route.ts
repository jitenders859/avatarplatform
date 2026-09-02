import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { computeFreeWindowsByDate } from "@/lib/availability";
import { env } from "@/lib/env";

/**
 * GET /api/instructors/:id/availability?days=14 — the student-facing calendar feed: free
 * windows per date, already expanded from the instructor's recurring rules with existing
 * bookings subtracted out. Public (no auth) — this is what powers the booking calendar.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const days = Math.min(60, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? "14")));

  const instructor = await prisma.instructor.findUnique({
    where: { id: params.id },
    include: { availability: true },
  });
  if (!instructor) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const busyBookings = await prisma.booking.findMany({
    where: {
      instructorId: instructor.id,
      status: { in: ["PENDING_PAYMENT", "CONFIRMED"] },
      endAt: { gt: new Date() },
    },
    select: { startAt: true, endAt: true },
  });

  const windowsByDate = computeFreeWindowsByDate({
    timezone: instructor.timezone,
    rules: instructor.availability,
    busy: busyBookings,
    days,
    minNoticeMinutes: env.minBookingNoticeMinutes,
  });

  const dates: Record<string, { startAt: string; endAt: string }[]> = {};
  for (const [date, windows] of windowsByDate) {
    dates[date] = windows.map((w) => ({ startAt: w.startAt.toISOString(), endAt: w.endAt.toISOString() }));
  }

  return NextResponse.json({
    timezone: instructor.timezone,
    minSessionMinutes: env.minSessionMinutes,
    maxSessionMinutes: env.maxSessionMinutes,
    sessionDurationStepMinutes: env.sessionDurationStepMinutes,
    dates,
  });
}
