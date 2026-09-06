import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import InstructorBooking from "@/components/InstructorBooking";

export const dynamic = "force-dynamic";

export default async function InstructorProfilePage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { booking?: string };
}) {
  const instructor = await prisma.instructor.findUnique({
    where: { id: params.id },
    include: {
      user: { select: { name: true } },
      countries: { include: { country: true } },
      licenseTypes: { include: { licenseType: true } },
    },
  });

  if (!instructor) notFound();

  const reviews = await prisma.review.findMany({
    where: { instructorId: instructor.id },
    include: { student: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return (
    <div className="container section">
      {searchParams.booking === "canceled" && <p className="dim">Checkout canceled — no charge was made.</p>}
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

      {reviews.length > 0 && (
        <>
          <h2 style={{ marginTop: 32 }}>Reviews</h2>
          <div className="grid grid-2">
            {reviews.map((r) => (
              <div className="card" key={r.id}>
                <strong>
                  {"★".repeat(r.rating)}
                  {"☆".repeat(5 - r.rating)}
                </strong>
                <p className="dim" style={{ fontSize: 13 }}>
                  {r.student.name} · {new Date(r.createdAt).toLocaleDateString()}
                </p>
                {r.comment && <p style={{ marginTop: 8 }}>{r.comment}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
