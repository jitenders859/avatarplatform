import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** GET /api/instructors/:id/reviews — public, most recent first. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const reviews = await prisma.review.findMany({
    where: { instructorId: params.id },
    include: { student: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json({ reviews });
}
