import Link from "next/link";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function InstructorsPage({
  searchParams,
}: {
  searchParams: { country?: string; license?: string };
}) {
  const [instructors, countries, licenseTypes] = await Promise.all([
    prisma.instructor.findMany({
      where: {
        connectOnboarded: true,
        countries: searchParams.country ? { some: { country: { code: searchParams.country } } } : undefined,
        licenseTypes: searchParams.license ? { some: { licenseType: { code: searchParams.license } } } : undefined,
      },
      include: {
        user: { select: { name: true } },
        countries: { include: { country: true } },
        licenseTypes: { include: { licenseType: true } },
      },
      orderBy: [{ ratingAvg: "desc" }, { ratingCount: "desc" }],
    }),
    prisma.country.findMany({ orderBy: { name: "asc" } }),
    prisma.licenseType.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="container section">
      <h1>Instructors</h1>
      <p className="dim">Every first session is free — up to 30 minutes, on us.</p>

      <form style={{ display: "flex", gap: 12, margin: "20px 0" }}>
        <select name="country" defaultValue={searchParams.country ?? ""}>
          <option value="">Any country</option>
          {countries.map((c) => (
            <option key={c.id} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
        <select name="license" defaultValue={searchParams.license ?? ""}>
          <option value="">Any license</option>
          {licenseTypes.map((l) => (
            <option key={l.id} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
        <button className="btn btn-secondary" type="submit">
          Filter
        </button>
      </form>

      {instructors.length === 0 && <p className="dim">No instructors match yet — check back soon.</p>}

      <div className="grid grid-3">
        {instructors.map((i) => (
          <div className="card" key={i.id}>
            <strong>{i.user.name}</strong>
            <p className="dim">
              ${(i.hourlyRateCents / 100).toFixed(0)}/hr · {i.ratingAvg > 0 ? `${i.ratingAvg.toFixed(1)}★` : "New"}
            </p>
            <p className="dim" style={{ fontSize: 13 }}>
              {i.licenseTypes.map((lt) => lt.licenseType.code).join(", ")} ·{" "}
              {i.countries.map((c) => c.country.code).join(", ")}
            </p>
            <Link href={`/instructors/${i.id}`} className="btn btn-secondary">
              View profile
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
