"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import Calendar from "@/components/Calendar";

interface Window {
  startAt: string;
  endAt: string;
}

interface AvailabilityResponse {
  timezone: string;
  minSessionMinutes: number;
  maxSessionMinutes: number;
  sessionDurationStepMinutes: number;
  dates: Record<string, Window[]>;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default function InstructorBooking({
  instructorId,
  instructorName,
  hourlyRateCents,
  currency,
}: {
  instructorId: string;
  instructorName: string;
  hourlyRateCents: number;
  currency: string;
}) {
  const router = useRouter();
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedStart, setSelectedStart] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<AvailabilityResponse>(`/api/instructors/${instructorId}/availability?days=30`)
      .then(setAvailability)
      .catch(() => setError("Couldn't load this instructor's availability."));
  }, [instructorId]);

  const availableDates = useMemo(() => new Set(Object.keys(availability?.dates ?? {})), [availability]);

  const windowsForDate = selectedDate ? availability?.dates[selectedDate] ?? [] : [];

  const candidateStarts = useMemo(() => {
    if (!availability) return [];
    const step = availability.sessionDurationStepMinutes;
    const min = availability.minSessionMinutes;
    const starts: string[] = [];
    for (const w of windowsForDate) {
      let cursor = new Date(w.startAt).getTime();
      const end = new Date(w.endAt).getTime();
      while (cursor + min * 60_000 <= end) {
        starts.push(new Date(cursor).toISOString());
        cursor += step * 60_000;
      }
    }
    return starts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, selectedDate]);

  const durationOptions = useMemo(() => {
    if (!availability || !selectedStart) return [];
    const containingWindow = windowsForDate.find(
      (w) => new Date(selectedStart) >= new Date(w.startAt) && new Date(selectedStart) < new Date(w.endAt)
    );
    if (!containingWindow) return [];
    const maxFit = Math.floor(
      (new Date(containingWindow.endAt).getTime() - new Date(selectedStart).getTime()) / 60_000
    );
    const options: number[] = [];
    for (let d = availability.minSessionMinutes; d <= Math.min(availability.maxSessionMinutes, maxFit); d += availability.sessionDurationStepMinutes) {
      options.push(d);
    }
    return options;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, selectedStart, windowsForDate]);

  async function book() {
    if (!selectedStart || !duration) return;
    setBooking(true);
    setError(null);
    try {
      const res = await apiFetch<{ checkoutUrl: string | null }>("/api/bookings", {
        method: "POST",
        body: JSON.stringify({ instructorId, startAt: selectedStart, durationMinutes: duration }),
      });
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        router.push("/dashboard?booking=success");
        router.refresh();
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.push(`/login?next=/instructors/${instructorId}`);
        return;
      }
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
      setBooking(false);
    }
  }

  if (error && !availability) return <p className="error">{error}</p>;
  if (!availability) return <p className="dim">Loading availability…</p>;

  if (availableDates.size === 0) {
    return <p className="dim">No open availability right now — check back soon.</p>;
  }

  const estimate = duration ? ((hourlyRateCents / 100) * (duration / 60)).toFixed(2) : null;

  return (
    <div>
      <Calendar
        availableDates={availableDates}
        selectedDate={selectedDate}
        onSelect={(date) => {
          setSelectedDate(date);
          setSelectedStart(null);
          setDuration(null);
        }}
      />

      {selectedDate && (
        <div style={{ marginTop: 20 }}>
          <h4>Start time</h4>
          <p className="dim" style={{ fontSize: 13 }}>
            Shown in your local time. {instructorName}&apos;s calendar is in {availability.timezone}.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {candidateStarts.map((s) => (
              <button
                type="button"
                key={s}
                className={`btn ${selectedStart === s ? "" : "btn-secondary"}`}
                onClick={() => {
                  setSelectedStart(s);
                  setDuration(null);
                }}
              >
                {fmtTime(s)}
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedStart && (
        <div style={{ marginTop: 20 }}>
          <h4>Session length</h4>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {durationOptions.map((d) => (
              <button
                type="button"
                key={d}
                className={`btn ${duration === d ? "" : "btn-secondary"}`}
                onClick={() => setDuration(d)}
              >
                {d < 60 ? `${d} min` : d === 60 ? "1 hour" : `${(d / 60).toFixed(1).replace(/\.0$/, "")} hours`}
              </button>
            ))}
          </div>
        </div>
      )}

      {duration && (
        <div className="card" style={{ marginTop: 20 }}>
          <p>
            <strong>
              {new Date(selectedStart!).toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </strong>{" "}
            · {duration} min
          </p>
          <p className="dim">
            ~${estimate} {currency.toUpperCase()} + platform fee — free if this is your first session with{" "}
            {instructorName}.
          </p>
          {error && <p className="error">{error}</p>}
          <button className="btn" onClick={book} disabled={booking}>
            {booking ? "Booking…" : "Book this session"}
          </button>
        </div>
      )}
    </div>
  );
}
