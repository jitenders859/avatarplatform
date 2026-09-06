import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";

/** DELETE /api/instructors/:id/availability-rules/:ruleId — remove one recurring window (owner only). */
export async function DELETE(_req: Request, { params }: { params: { id: string; ruleId: string } }) {
  try {
    const user = await requireUser();
    const instructor = await prisma.instructor.findUnique({ where: { id: params.id } });
    if (!instructor || instructor.userId !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rule = await prisma.instructorAvailability.findUnique({ where: { id: params.ruleId } });
    if (!rule || rule.instructorId !== instructor.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.instructorAvailability.delete({ where: { id: rule.id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
