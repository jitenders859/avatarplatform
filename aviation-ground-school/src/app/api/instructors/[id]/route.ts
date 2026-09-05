import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** GET /api/instructors/:id — public profile. Fetch /api/instructors/:id/availability for their calendar. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const instructor = await prisma.instructor.findUnique({
    where: { id: params.id },
    include: {
      user: { select: { name: true } },
      countries: { include: { country: true } },
      licenseTypes: { include: { licenseType: true } },
    },
  });

  if (!instructor) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ instructor });
}
