import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** GET /api/instructors/:id — public profile + open (unbooked, future) slots. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const instructor = await prisma.instructor.findUnique({
    where: { id: params.id },
    include: {
      user: { select: { name: true } },
      countries: { include: { country: true } },
      licenseTypes: { include: { licenseType: true } },
      slots: {
        where: { isBooked: false, startAt: { gt: new Date() } },
        orderBy: { startAt: "asc" },
      },
    },
  });

  if (!instructor) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ instructor });
}
