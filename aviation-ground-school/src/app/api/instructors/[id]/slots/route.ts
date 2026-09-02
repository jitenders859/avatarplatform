import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";

/** GET /api/instructors/:id/slots — open future slots for booking. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const slots = await prisma.instructorSlot.findMany({
    where: { instructorId: params.id, isBooked: false, startAt: { gt: new Date() } },
    orderBy: { startAt: "asc" },
  });
  return NextResponse.json({ slots });
}

const createSchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
});

/** POST /api/instructors/:id/slots — instructor opens up a bookable window (owner only). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = createSchema.parse(await req.json());

    const instructor = await prisma.instructor.findUnique({ where: { id: params.id } });
    if (!instructor || instructor.userId !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const startAt = new Date(body.startAt);
    const endAt = new Date(body.endAt);
    if (endAt <= startAt) {
      return NextResponse.json({ error: "endAt must be after startAt" }, { status: 400 });
    }

    const slot = await prisma.instructorSlot.create({
      data: { instructorId: instructor.id, startAt, endAt },
    });

    return NextResponse.json({ slot }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
