import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";

/** GET /api/instructors/:id/availability-rules — the instructor's own recurring weekly windows (owner only). */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const instructor = await prisma.instructor.findUnique({ where: { id: params.id } });
    if (!instructor || instructor.userId !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const rules = await prisma.instructorAvailability.findMany({
      where: { instructorId: instructor.id },
      orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
    });
    return NextResponse.json({ timezone: instructor.timezone, rules });
  } catch (err) {
    return apiError(err);
  }
}

const createSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
});

/** POST /api/instructors/:id/availability-rules — add one recurring weekly window (owner only). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = createSchema.parse(await req.json());
    if (body.endMinute <= body.startMinute) {
      return NextResponse.json({ error: "endMinute must be after startMinute" }, { status: 400 });
    }

    const instructor = await prisma.instructor.findUnique({ where: { id: params.id } });
    if (!instructor || instructor.userId !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rule = await prisma.instructorAvailability.create({
      data: { instructorId: instructor.id, ...body },
    });

    return NextResponse.json({ rule }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
