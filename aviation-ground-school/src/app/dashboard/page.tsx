"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";

interface Me {
  id: string;
  name: string;
  subscriptionStatus: string | null;
}
interface ChatSessionRow {
  id: string;
  updatedAt: string;
  chatbot: { title: string };
}
interface BookingRow {
  id: string;
  startAt: string;
  status: string;
  isFreeSession: boolean;
  priceCents: number;
  instructor: { user: { name: string } };
}

export default function DashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    apiFetch<{ user: Me | null }>("/api/auth/me").then((res) => {
      if (!res.user) {
        router.push("/login?next=/dashboard");
        return;
      }
      setMe(res.user);
    });
    apiFetch<{ sessions: ChatSessionRow[] }>("/api/chat/sessions")
      .then((res) => setSessions(res.sessions))
      .catch(() => {});
    apiFetch<{ asStudent: BookingRow[] }>("/api/bookings")
      .then((res) => setBookings(res.asStudent))
      .catch(() => {});
  }, [router]);

  async function openBillingPortal() {
    setPortalLoading(true);
    try {
      const { url } = await apiFetch<{ url: string }>("/api/subscriptions/portal", { method: "POST" });
      window.location.href = url;
    } catch (err) {
      if (err instanceof ApiClientError) alert(err.message);
    } finally {
      setPortalLoading(false);
    }
  }

  if (me === undefined) return null;

  return (
    <div className="container section">
      <h1>Welcome back, {me?.name}</h1>

      <div className="card" style={{ marginTop: 20 }}>
        <strong>Subscription: {me?.subscriptionStatus ?? "None yet"}</strong>
        <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
          {me?.subscriptionStatus && (
            <button className="btn btn-secondary" onClick={openBillingPortal} disabled={portalLoading}>
              {portalLoading ? "Loading…" : "Manage billing"}
            </button>
          )}
          {!me?.subscriptionStatus && (
            <Link href="/pricing" className="btn">
              See plans
            </Link>
          )}
        </div>
      </div>

      <h2 style={{ marginTop: 32 }}>Your chats</h2>
      {sessions.length === 0 && <p className="dim">No chats yet.</p>}
      <div className="grid grid-3">
        {sessions.map((s) => (
          <Link href={`/chat/${s.id}`} key={s.id} className="card">
            <strong>{s.chatbot.title}</strong>
            <p className="dim">{new Date(s.updatedAt).toLocaleDateString()}</p>
          </Link>
        ))}
      </div>

      <h2 style={{ marginTop: 32 }}>Your instructor bookings</h2>
      {bookings.length === 0 && <p className="dim">No bookings yet — visit the instructor directory to book one.</p>}
      {bookings.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Instructor</th>
              <th>When</th>
              <th>Status</th>
              <th>Price</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id}>
                <td>{b.instructor.user.name}</td>
                <td>{new Date(b.startAt).toLocaleString()}</td>
                <td>{b.status}</td>
                <td>{b.isFreeSession ? "Free" : `$${(b.priceCents / 100).toFixed(2)}`}</td>
                <td>
                  {b.status === "CONFIRMED" && (
                    <Link href={`/session/${b.id}`} className="btn btn-secondary">
                      Join call
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
