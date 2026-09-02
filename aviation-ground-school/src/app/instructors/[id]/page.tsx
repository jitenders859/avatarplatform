import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import InstructorBooking from "@/components/InstructorBooking";

export const dynamic = "force-dynamic";

export default async function InstructorProfilePage({ params }: { params: { id: string } }) {
  const instructor = await prisma.instructor.findUnique({
    where: { id: params.id },
    include: {
      user: { select: { name: true } },
      countries: { include: { country: true } },
      licenseTypes: { include: { licenseType: true } },
    },
  });

  if (!instructor) notFound();

  return (
    <div className="container section">
      <div className="card">
        <h1>{instructor.user.name}</h1>
        <p className="dim">
          ${(instructor.hourlyRateCents / 100).toFixed(0)}/hr ·{" "}
          {instructor.ratingAvg > 0 ? `${instructor.ratingAvg.toFixed(1)}★ (${instructor.ratingCount})` : "New instructor"}
        </p>
        <p className="dim" style={{ fontSize: 13 }}>
          Teaches {instructor.licenseTypes.map((lt) => lt.licenseType.name).join(", ")} in{" "}
          {instructor.countries.map((c) => c.country.name).join(", ")}
        </p>
        {instructor.bio && <p style={{ marginTop: 16 }}>{instructor.bio}</p>}
      </div>

      <h2 style={{ marginTop: 32 }}>Book a session</h2>
      <p className="dim">Your first session with {instructor.user.name} is free.</p>

      <InstructorBooking
        instructorId={instructor.id}
        instructorName={instructor.user.name}
        hourlyRateCents={instructor.hourlyRateCents}
        currency={instructor.currency}
      />
    </div>
  );
}
