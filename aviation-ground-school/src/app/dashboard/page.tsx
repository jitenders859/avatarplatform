"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";

interface Me {
  id: string;
  name: string;
  subscriptionStatus: string | null;
  subscriptionCancelAtPeriodEnd: boolean;
  subscriptionCurrentPeriodEnd: string | null;
  emailVerified: boolean;
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
  review: { id: string } | null;
}

export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [portalLoading, setPortalLoading] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  function refreshBookings() {
    apiFetch<{ asStudent: BookingRow[] }>("/api/bookings")
      .then((res) => setBookings(res.asStudent))
      .catch(() => {});
  }

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
    refreshBookings();
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

  async function resendVerification() {
    setResendState("sending");
    try {
      await apiFetch("/api/auth/resend-verification", { method: "POST" });
      setResendState("sent");
    } catch {
      setResendState("idle");
    }
  }

  if (me === undefined) return null;

  const verifiedNotice = searchParams.get("verified");
  const bookingNotice = searchParams.get("booking");
  const checkoutNotice = searchParams.get("checkout");

  return (
    <div className="container section">
      <h1>Welcome back, {me?.name}</h1>

      {verifiedNotice === "1" && <p className="dim">Email verified — thanks!</p>}
      {bookingNotice === "success" && <p className="dim">Booking confirmed — see it below.</p>}
      {checkoutNotice === "success" && <p className="dim">Subscription active — you're all set.</p>}

      {me && !me.emailVerified && (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="dim" style={{ margin: 0 }}>
            Your email isn&apos;t verified yet.{" "}
            {resendState === "sent" ? (
              "Check your inbox for a new link."
            ) : (
              <button
                className="btn btn-secondary"
                style={{ marginLeft: 8 }}
                onClick={resendVerification}
                disabled={resendState === "sending"}
              >
                {resendState === "sending" ? "Sending…" : "Resend verification email"}
              </button>
            )}
          </p>
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <strong>Subscription: {me?.subscriptionStatus ?? "None yet"}</strong>
        {me?.subscriptionStatus && me.subscriptionCurrentPeriodEnd && (
          <p className="dim" style={{ margin: "4px 0 0" }}>
            {me.subscriptionCancelAtPeriodEnd
              ? `Cancels on ${new Date(me.subscriptionCurrentPeriodEnd).toLocaleDateString()} — you'll keep access until then.`
              : `Renews on ${new Date(me.subscriptionCurrentPeriodEnd).toLocaleDateString()}.`}
          </p>
        )}
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
      {bookings.map((b) => (
        <BookingCard key={b.id} booking={b} onChanged={refreshBookings} />
      ))}
    </div>
  );
}

function BookingCard({ booking, onChanged }: { booking: BookingRow; onChanged: () => void }) {
  const [showReschedule, setShowReschedule] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [newTime, setNewTime] = useState("");
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFuture = new Date(booking.startAt).getTime() > Date.now();

  async function cancel() {
    if (!confirm("Cancel this session?")) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/bookings/${booking.id}/cancel`, { method: "POST" });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function reschedule() {
    if (!newTime) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/bookings/${booking.id}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ startAt: new Date(newTime).toISOString() }),
      });
      setShowReschedule(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function submitReview() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/bookings/${booking.id}/review`, {
        method: "POST",
        body: JSON.stringify({ rating, comment: comment || undefined }),
      });
      setShowReview(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <strong>{booking.instructor.user.name}</strong>
          <p className="dim" style={{ margin: "4px 0 0" }}>
            {new Date(booking.startAt).toLocaleString()} · {booking.status} ·{" "}
            {booking.isFreeSession ? "Free" : `$${(booking.priceCents / 100).toFixed(2)}`}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          {booking.status === "CONFIRMED" && (
            <Link href={`/session/${booking.id}`} className="btn btn-secondary">
              Join call
            </Link>
          )}
          {booking.status === "CONFIRMED" && isFuture && (
            <button className="btn btn-secondary" onClick={() => setShowReschedule((v) => !v)} disabled={busy}>
              Reschedule
            </button>
          )}
          {(booking.status === "CONFIRMED" || booking.status === "PENDING_PAYMENT") && isFuture && (
            <button className="btn btn-secondary" onClick={cancel} disabled={busy}>
              Cancel
            </button>
          )}
          {booking.status === "COMPLETED" && !booking.review && (
            <button className="btn btn-secondary" onClick={() => setShowReview((v) => !v)} disabled={busy}>
              Leave a review
            </button>
          )}
          {booking.status === "COMPLETED" && booking.review && <span className="dim">Reviewed</span>}
        </div>
      </div>

      {showReschedule && (
        <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input type="datetime-local" value={newTime} onChange={(e) => setNewTime(e.target.value)} />
          <button className="btn" onClick={reschedule} disabled={busy || !newTime}>
            {busy ? "Saving…" : "Confirm new time"}
          </button>
        </div>
      )}

      {showReview && (
        <div style={{ marginTop: 14 }}>
          <div className="field">
            <label>Rating</label>
            <select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {"★".repeat(n)}
                  {"☆".repeat(5 - n)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Comment (optional)</label>
            <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <button className="btn" onClick={submitReview} disabled={busy}>
            {busy ? "Submitting…" : "Submit review"}
          </button>
        </div>
      )}

      {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}
    </div>
  );
}
