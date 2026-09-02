"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";

interface BookingDetail {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  student: { name: string };
  instructor: { user: { name: string } };
}

export default function SessionPage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ booking: BookingDetail }>(`/api/bookings/${bookingId}`)
      .then((res) => setBooking(res.booking))
      .catch((err) => {
        if (err instanceof ApiClientError && err.status === 401) {
          router.push(`/login?next=/session/${bookingId}`);
        }
      });
  }, [bookingId, router]);

  useEffect(() => {
    if (!booking) return;
    let cancelled = false;

    async function tryJoin() {
      try {
        const res = await apiFetch<{ url: string }>(`/api/bookings/${bookingId}/join`);
        if (!cancelled) {
          setJoinUrl(res.url);
          setNotice(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError) {
          if (err.status === 409) {
            const payload = err.payload as { error?: string; opensAt?: string };
            if (payload.opensAt) {
              setNotice(`The call opens at ${new Date(payload.opensAt).toLocaleTimeString()}.`);
            } else {
              setNotice(payload.error ?? "This call isn't available right now.");
            }
          } else {
            setNotice(err.message);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    tryJoin();
    const interval = setInterval(tryJoin, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [booking, bookingId]);

  if (!booking) return <div className="container section">{loading ? <p className="dim">Loading…</p> : null}</div>;

  return (
    <div className="container section">
      <h1>
        Session with {booking.student.name} & {booking.instructor.user.name}
      </h1>
      <p className="dim">
        {new Date(booking.startAt).toLocaleString()} – {new Date(booking.endAt).toLocaleTimeString()}
      </p>

      {joinUrl ? (
        <iframe
          src={joinUrl}
          allow="camera; microphone; fullscreen; display-capture; autoplay"
          style={{ width: "100%", height: "70vh", border: "1px solid var(--border)", borderRadius: 10, marginTop: 20 }}
        />
      ) : (
        <div className="card" style={{ marginTop: 20 }}>
          <p>{notice ?? "Checking call status…"}</p>
        </div>
      )}
    </div>
  );
}
