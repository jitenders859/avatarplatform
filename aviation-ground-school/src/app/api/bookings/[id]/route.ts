import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";

/** GET /api/bookings/:id — detail for the session page (participants only). */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: {
        student: { select: { id: true, name: true } },
        instructor: { include: { user: { select: { id: true, name: true } } } },
      },
    });
    if (!booking) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (booking.studentId !== user.id && booking.instructor.userId !== user.id) {
      return NextResponse.json({ error: "Not your booking" }, { status: 403 });
    }

    return NextResponse.json({ booking, isInstructor: booking.instructor.userId === user.id });
  } catch (err) {
    return apiError(err);
  }
}
