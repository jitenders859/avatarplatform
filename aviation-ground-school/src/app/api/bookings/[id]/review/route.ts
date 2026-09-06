import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";

const bodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

/** POST /api/bookings/:id/review — student rates a completed session; recomputes the instructor's aggregate. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = bodySchema.parse(await req.json());

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: { review: true },
    });
    if (!booking) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (booking.studentId !== user.id) {
      return NextResponse.json({ error: "Not your booking" }, { status: 403 });
    }
    if (booking.status !== "COMPLETED") {
      return NextResponse.json({ error: "You can only review a session after it's completed" }, { status: 409 });
    }
    if (booking.review) {
      return NextResponse.json({ error: "You already reviewed this session" }, { status: 409 });
    }

    const review = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          bookingId: booking.id,
          studentId: user.id,
          instructorId: booking.instructorId,
          rating: body.rating,
          comment: body.comment,
        },
      });

      const instructor = await tx.instructor.findUniqueOrThrow({ where: { id: booking.instructorId } });
      const newCount = instructor.ratingCount + 1;
      const newAvg = (instructor.ratingAvg * instructor.ratingCount + body.rating) / newCount;
      await tx.instructor.update({
        where: { id: instructor.id },
        data: { ratingAvg: newAvg, ratingCount: newCount },
      });

      return created;
    });

    return NextResponse.json({ review }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
