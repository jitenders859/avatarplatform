import { prisma } from "@/lib/db";

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

/** Whether `studentId` has ever booked (any status past pending) a session with this instructor before. */
export async function hasPriorBooking(studentId: string, instructorId: string): Promise<boolean> {
  const existing = await prisma.booking.findFirst({
    where: {
      studentId,
      instructorId,
      status: { in: ["CONFIRMED", "COMPLETED"] },
    },
    select: { id: true },
  });
  return existing !== null;
}
