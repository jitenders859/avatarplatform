import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") notFound();

  const revenueStatuses = ["CONFIRMED", "COMPLETED"] as const;

  const [
    userCount,
    studentCount,
    instructorCount,
    pendingConnectCount,
    activeSubscriptionCount,
    bookingsByStatus,
    revenue,
    recentUsers,
    recentBookings,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: "STUDENT" } }),
    prisma.instructor.count(),
    prisma.instructor.count({ where: { connectOnboarded: false } }),
    prisma.subscription.count({ where: { status: { in: ["ACTIVE", "TRIALING"] } } }),
    prisma.booking.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.booking.aggregate({
      where: { status: { in: [...revenueStatuses] } },
      _sum: { priceCents: true, commissionCents: true },
    }),
    prisma.user.findMany({ orderBy: { createdAt: "desc" }, take: 10, select: { id: true, name: true, email: true, role: true, createdAt: true } }),
    prisma.booking.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        student: { select: { name: true } },
        instructor: { include: { user: { select: { name: true } } } },
      },
    }),
  ]);

  const statusCounts = Object.fromEntries(bookingsByStatus.map((b) => [b.status, b._count._all]));
  const grossRevenueCents = revenue._sum.priceCents ?? 0;
  const commissionCents = revenue._sum.commissionCents ?? 0;

  return (
    <div className="container section">
      <h1>Admin</h1>

      <div className="grid grid-3" style={{ marginTop: 20 }}>
        <Stat label="Users" value={userCount} />
        <Stat label="Students" value={studentCount} />
        <Stat label="Instructors" value={instructorCount} />
        <Stat label="Instructors pending payout setup" value={pendingConnectCount} />
        <Stat label="Active subscriptions" value={activeSubscriptionCount} />
        <Stat label="Gross booking revenue" value={`$${(grossRevenueCents / 100).toFixed(2)}`} />
        <Stat label="Platform commission" value={`$${(commissionCents / 100).toFixed(2)}`} />
        {(["PENDING_PAYMENT", "CONFIRMED", "COMPLETED", "CANCELED", "NO_SHOW"] as const).map((s) => (
          <Stat key={s} label={`Bookings: ${s}`} value={statusCounts[s] ?? 0} />
        ))}
      </div>

      <h2 style={{ marginTop: 32 }}>Recent users</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {recentUsers.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>{new Date(u.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 32 }}>Recent bookings</h2>
      <table>
        <thead>
          <tr>
            <th>Student</th>
            <th>Instructor</th>
            <th>When</th>
            <th>Status</th>
            <th>Price</th>
            <th>Commission</th>
          </tr>
        </thead>
        <tbody>
          {recentBookings.map((b) => (
            <tr key={b.id}>
              <td>{b.student.name}</td>
              <td>{b.instructor.user.name}</td>
              <td>{new Date(b.startAt).toLocaleString()}</td>
              <td>{b.status}</td>
              <td>{b.isFreeSession ? "Free" : `$${(b.priceCents / 100).toFixed(2)}`}</td>
              <td>{b.isFreeSession ? "—" : `$${(b.commissionCents / 100).toFixed(2)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card">
      <p className="dim" style={{ margin: 0, fontSize: 13 }}>
        {label}
      </p>
      <strong style={{ fontSize: 22 }}>{value}</strong>
    </div>
  );
}
