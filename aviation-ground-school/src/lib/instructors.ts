import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

type Queryable = typeof prisma | Prisma.TransactionClient;

/** Instructors who teach the given country + license type, best-rated first. */
export async function findMatchingInstructors(countryId: string, licenseTypeId: string, limit = 3) {
  return prisma.instructor.findMany({
    where: {
      connectOnboarded: true,
      countries: { some: { countryId } },
      licenseTypes: { some: { licenseTypeId } },
    },
    include: {
      user: { select: { id: true, name: true } },
    },
    orderBy: [{ ratingAvg: "desc" }, { ratingCount: "desc" }],
    take: limit,
  });
}

/**
 * Whether `studentId` is still eligible for a free first session with this instructor.
 *
 * A free booking consumes the trial the moment it's created (isFreeSession stays true
 * forever, even if the booking is later canceled) — otherwise a student could repeatedly
 * book-then-cancel a free session with the same instructor and never actually pay, since a
 * canceled booking would no longer show up as "prior" and the trial would reset. A canceled
 * *paid* booking, by contrast, doesn't burn eligibility — nothing free was ever given out.
 */
export async function hasUsedFreeTrial(
  studentId: string,
  instructorId: string,
  db: Queryable = prisma
): Promise<boolean> {
  const existing = await db.booking.findFirst({
    where: {
      studentId,
      instructorId,
      OR: [{ isFreeSession: true }, { status: { in: ["CONFIRMED", "COMPLETED"] } }],
    },
    select: { id: true },
  });
  return existing !== null;
}
