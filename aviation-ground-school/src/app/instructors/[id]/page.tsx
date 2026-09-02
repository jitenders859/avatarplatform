import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import BookSlotButton from "@/components/BookSlotButton";

export const dynamic = "force-dynamic";

export default async function InstructorProfilePage({ params }: { params: { id: string } }) {
  const instructor = await prisma.instructor.findUnique({
    where: { id: params.id },
    include: {
      user: { select: { name: true } },
      countries: { include: { country: true } },
      licenseTypes: { include: { licenseType: true } },
      slots: {
        where: { isBooked: false, startAt: { gt: new Date() } },
        orderBy: { startAt: "asc" },
        take: 20,
      },
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

      <h2 style={{ marginTop: 32 }}>Available times</h2>
      <p className="dim">Your first session with {instructor.user.name} is free.</p>

      {instructor.slots.length === 0 && <p className="dim">No open slots right now — check back soon.</p>}

      <div className="grid grid-3" style={{ marginTop: 12 }}>
        {instructor.slots.map((slot) => (
          <div className="card" key={slot.id}>
            <strong>
              {new Date(slot.startAt).toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </strong>
            <p className="dim">
              {Math.round((new Date(slot.endAt).getTime() - new Date(slot.startAt).getTime()) / 60000)} min
            </p>
            <BookSlotButton slotId={slot.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
