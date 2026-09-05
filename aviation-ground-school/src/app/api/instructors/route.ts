import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";

/** GET /api/instructors?country=US&license=CPL — directory search, best-rated first. */
export async function GET(req: NextRequest) {
  const countryCode = req.nextUrl.searchParams.get("country");
  const licenseCode = req.nextUrl.searchParams.get("license");

  const instructors = await prisma.instructor.findMany({
    where: {
      connectOnboarded: true,
      countries: countryCode ? { some: { country: { code: countryCode.toUpperCase() } } } : undefined,
      licenseTypes: licenseCode ? { some: { licenseType: { code: licenseCode.toUpperCase() } } } : undefined,
    },
    include: {
      user: { select: { name: true } },
      countries: { include: { country: true } },
      licenseTypes: { include: { licenseType: true } },
    },
    orderBy: [{ ratingAvg: "desc" }, { ratingCount: "desc" }],
  });

  return NextResponse.json({ instructors });
}

const createSchema = z.object({
  bio: z.string().max(4000).optional(),
  hourlyRateCents: z.number().int().min(500).max(100_000),
  currency: z.string().length(3).default("usd"),
  countryCodes: z.array(z.string().length(2)).min(1),
  licenseTypeCodes: z.array(z.string()).min(1),
  // IANA zone name, e.g. "America/New_York" — captured from the instructor's browser
  // (Intl.DateTimeFormat().resolvedOptions().timeZone) so their availability rules line up
  // with their actual local clock.
  timezone: z.string().min(1).max(100).default("UTC"),
});

/** POST /api/instructors — the current user becomes (or updates) an instructor profile. */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = createSchema.parse(await req.json());

    const [countries, licenseTypes] = await Promise.all([
      prisma.country.findMany({ where: { code: { in: body.countryCodes.map((c) => c.toUpperCase()) } } }),
      prisma.licenseType.findMany({ where: { code: { in: body.licenseTypeCodes.map((c) => c.toUpperCase()) } } }),
    ]);

    const instructor = await prisma.$transaction(async (tx) => {
      const record = await tx.instructor.upsert({
        where: { userId: user.id },
        update: {
          bio: body.bio,
          hourlyRateCents: body.hourlyRateCents,
          currency: body.currency,
          timezone: body.timezone,
        },
        create: {
          userId: user.id,
          bio: body.bio,
          hourlyRateCents: body.hourlyRateCents,
          currency: body.currency,
          timezone: body.timezone,
        },
      });

      await tx.instructorCountry.deleteMany({ where: { instructorId: record.id } });
      await tx.instructorLicenseType.deleteMany({ where: { instructorId: record.id } });
      await tx.instructorCountry.createMany({
        data: countries.map((c) => ({ instructorId: record.id, countryId: c.id })),
      });
      await tx.instructorLicenseType.createMany({
        data: licenseTypes.map((l) => ({ instructorId: record.id, licenseTypeId: l.id })),
      });

      if (user.role === "STUDENT") {
        await tx.user.update({ where: { id: user.id }, data: { role: "INSTRUCTOR" } });
      }

      return record;
    });

    return NextResponse.json({ instructor }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
