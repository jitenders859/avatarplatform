"use client";

import { Suspense, useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";

interface Me {
  id: string;
  name: string;
  isInstructor: boolean;
  instructor: {
    id: string;
    connectOnboarded: boolean;
    hourlyRateCents: number;
    bio: string | null;
    currency: string;
    timezone: string;
  } | null;
}
interface Country {
  id: string;
  code: string;
  name: string;
}
interface LicenseType {
  id: string;
  code: string;
  name: string;
}
interface BookingRow {
  id: string;
  startAt: string;
  status: string;
  isFreeSession: boolean;
  instructorPayoutCents: number;
  student: { name: string };
}

function isFutureBooking(b: BookingRow) {
  return new Date(b.startAt).getTime() > Date.now();
}

export default function InstructorDashboardPage() {
  return (
    <Suspense fallback={null}>
      <InstructorDashboardContent />
    </Suspense>
  );
}

function InstructorDashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [countries, setCountries] = useState<Country[]>([]);
  const [licenseTypes, setLicenseTypes] = useState<LicenseType[]>([]);
  const [bookings, setBookings] = useState<BookingRow[]>([]);

  function refreshMe() {
    apiFetch<{ user: Me | null }>("/api/auth/me").then((res) => {
      if (!res.user) {
        router.push("/login?next=/instructor-dashboard");
        return;
      }
      setMe(res.user);
    });
  }

  function refreshBookings() {
    apiFetch<{ asInstructor: BookingRow[] }>("/api/bookings")
      .then((res) => setBookings(res.asInstructor))
      .catch(() => {});
  }

  async function cancelBooking(id: string) {
    if (!confirm("Cancel this session?")) return;
    try {
      await apiFetch(`/api/bookings/${id}/cancel`, { method: "POST" });
      refreshBookings();
    } catch (err) {
      if (err instanceof ApiClientError) alert(err.message);
    }
  }

  async function markNoShow(id: string) {
    if (!confirm("Mark this session as a no-show?")) return;
    try {
      await apiFetch(`/api/bookings/${id}/no-show`, { method: "POST" });
      refreshBookings();
    } catch (err) {
      if (err instanceof ApiClientError) alert(err.message);
    }
  }

  useEffect(() => {
    refreshMe();
    apiFetch<{ countries: Country[] }>("/api/countries").then((res) => setCountries(res.countries));
    apiFetch<{ licenseTypes: LicenseType[] }>("/api/license-types").then((res) => setLicenseTypes(res.licenseTypes));
    refreshBookings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (me === undefined) return null;

  const connectNotice = searchParams.get("connect");

  return (
    <div className="container section">
      <h1>Teaching on Ground School AI</h1>

      {connectNotice === "return" && !me?.instructor?.connectOnboarded && (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="dim" style={{ margin: 0 }}>
            Stripe onboarding submitted — this can take a minute to reflect here.{" "}
            <button className="btn btn-secondary" onClick={refreshMe} style={{ marginLeft: 8 }}>
              Refresh status
            </button>
          </p>
        </div>
      )}
      {connectNotice === "refresh" && (
        <p className="dim">That onboarding link expired — click below to get a new one.</p>
      )}

      {!me?.isInstructor && (
        <InstructorProfileForm
          countries={countries}
          licenseTypes={licenseTypes}
          onDone={refreshMe}
          submitLabel="Create instructor profile"
        />
      )}

      {me?.isInstructor && !me.instructor?.connectOnboarded && <ConnectOnboardingCard />}

      {me?.isInstructor && me.instructor && (
        <InstructorProfileEditor
          instructorId={me.instructor.id}
          countries={countries}
          licenseTypes={licenseTypes}
          onDone={refreshMe}
        />
      )}

      {me?.isInstructor && me.instructor?.connectOnboarded && me.instructor && (
        <AvailabilityEditor instructorId={me.instructor.id} />
      )}

      {me?.isInstructor && (
        <>
          <h2 style={{ marginTop: 32 }}>Your bookings</h2>
          {bookings.length === 0 && <p className="dim">No bookings yet.</p>}
          {bookings.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>When</th>
                  <th>Status</th>
                  <th>Your payout</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id}>
                    <td>{b.student.name}</td>
                    <td>{new Date(b.startAt).toLocaleString()}</td>
                    <td>{b.status}</td>
                    <td>{b.isFreeSession ? "Free session" : `$${(b.instructorPayoutCents / 100).toFixed(2)}`}</td>
                    <td style={{ display: "flex", gap: 8 }}>
                      {b.status === "CONFIRMED" && (
                        <Link href={`/session/${b.id}`} className="btn btn-secondary">
                          Join call
                        </Link>
                      )}
                      {(b.status === "CONFIRMED" || b.status === "PENDING_PAYMENT") && isFutureBooking(b) && (
                        <button className="btn btn-secondary" onClick={() => cancelBooking(b.id)}>
                          Cancel
                        </button>
                      )}
                      {(b.status === "CONFIRMED" || b.status === "COMPLETED") && !isFutureBooking(b) && (
                        <button className="btn btn-secondary" onClick={() => markNoShow(b.id)}>
                          Mark no-show
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {me?.isInstructor && me.instructor && <ReviewsReceived instructorId={me.instructor.id} />}
    </div>
  );
}

interface ReviewRow {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  student: { name: string };
}

function ReviewsReceived({ instructorId }: { instructorId: string }) {
  const [reviews, setReviews] = useState<ReviewRow[] | null>(null);

  useEffect(() => {
    apiFetch<{ reviews: ReviewRow[] }>(`/api/instructors/${instructorId}/reviews`)
      .then((res) => setReviews(res.reviews))
      .catch(() => setReviews([]));
  }, [instructorId]);

  if (reviews === null) return null;

  return (
    <>
      <h2 style={{ marginTop: 32 }}>Reviews you&apos;ve received</h2>
      {reviews.length === 0 && <p className="dim">No reviews yet.</p>}
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
  );
}

interface InstructorProfileInitial {
  hourlyRate: number;
  bio: string;
  currency: string;
  countryCodes: string[];
  licenseTypeCodes: string[];
}

/** Shared form for both "become an instructor" (empty initial values) and editing afterward. */
function InstructorProfileForm({
  countries,
  licenseTypes,
  onDone,
  submitLabel,
  initial,
}: {
  countries: Country[];
  licenseTypes: LicenseType[];
  onDone: () => void;
  submitLabel: string;
  initial?: InstructorProfileInitial;
}) {
  const [hourlyRate, setHourlyRate] = useState(initial?.hourlyRate ?? 75);
  const [bio, setBio] = useState(initial?.bio ?? "");
  const [selectedCountries, setSelectedCountries] = useState<string[]>(initial?.countryCodes ?? []);
  const [selectedLicenses, setSelectedLicenses] = useState<string[]>(initial?.licenseTypeCodes ?? []);
  const [timezoneOverride, setTimezoneOverride] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  function toggle(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setLoading(true);
    try {
      const timezone = timezoneOverride ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
      await apiFetch("/api/instructors", {
        method: "POST",
        body: JSON.stringify({
          hourlyRateCents: Math.round(hourlyRate * 100),
          bio,
          currency: initial?.currency ?? "usd",
          countryCodes: selectedCountries,
          licenseTypeCodes: selectedLicenses,
          timezone,
        }),
      });
      setSaved(true);
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card" style={{ marginTop: 20 }}>
      <h3>{initial ? "Edit your instructor profile" : "Become an instructor"}</h3>
      <div className="field">
        <label>Hourly rate (USD)</label>
        <input
          type="number"
          min={5}
          value={hourlyRate}
          onChange={(e) => setHourlyRate(Number(e.target.value))}
          required
        />
      </div>
      <div className="field">
        <label>Bio</label>
        <textarea rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />
      </div>
      <div className="field">
        <label>Countries you teach</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {countries.map((c) => (
            <label key={c.id} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={selectedCountries.includes(c.code)}
                onChange={() => toggle(selectedCountries, setSelectedCountries, c.code)}
              />
              {c.name}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label>License types you teach</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {licenseTypes.map((l) => (
            <label key={l.id} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={selectedLicenses.includes(l.code)}
                onChange={() => toggle(selectedLicenses, setSelectedLicenses, l.code)}
              />
              {l.name}
            </label>
          ))}
        </div>
      </div>
      {initial && (
        <div className="field">
          <label>Timezone</label>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className="dim">{timezoneOverride ?? "unchanged"}</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setTimezoneOverride(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}
            >
              Use my current browser timezone
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {saved && <p className="dim">Saved.</p>}
      <button className="btn" type="submit" disabled={loading || selectedCountries.length === 0 || selectedLicenses.length === 0}>
        {loading ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

/** Fetches the instructor's current profile so InstructorProfileForm can be pre-filled for editing. */
function InstructorProfileEditor({
  instructorId,
  countries,
  licenseTypes,
  onDone,
}: {
  instructorId: string;
  countries: Country[];
  licenseTypes: LicenseType[];
  onDone: () => void;
}) {
  const [initial, setInitial] = useState<InstructorProfileInitial | null>(null);

  useEffect(() => {
    apiFetch<{
      instructor: {
        hourlyRateCents: number;
        bio: string | null;
        currency: string;
        countries: { country: { code: string } }[];
        licenseTypes: { licenseType: { code: string } }[];
      };
    }>(`/api/instructors/${instructorId}`).then((res) => {
      setInitial({
        hourlyRate: res.instructor.hourlyRateCents / 100,
        bio: res.instructor.bio ?? "",
        currency: res.instructor.currency,
        countryCodes: res.instructor.countries.map((c) => c.country.code),
        licenseTypeCodes: res.instructor.licenseTypes.map((l) => l.licenseType.code),
      });
    });
  }, [instructorId]);

  if (!initial || countries.length === 0 || licenseTypes.length === 0) return null;

  return (
    <InstructorProfileForm
      countries={countries}
      licenseTypes={licenseTypes}
      onDone={onDone}
      submitLabel="Save changes"
      initial={initial}
    />
  );
}

function ConnectOnboardingCard() {
  const [loading, setLoading] = useState(false);

  async function connect() {
    setLoading(true);
    try {
      const { url } = await apiFetch<{ url: string }>("/api/instructors/connect/onboarding", { method: "POST" });
      window.location.href = url;
    } catch (err) {
      if (err instanceof ApiClientError) alert(err.message);
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3>Finish payout setup</h3>
      <p className="dim">
        We use Stripe Connect to pay you out for booked sessions. Complete their onboarding form to start accepting
        bookings.
      </p>
      <button className="btn" onClick={connect} disabled={loading}>
        {loading ? "Redirecting…" : "Set up payouts with Stripe"}
      </button>
    </div>
  );
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface Rule {
  id: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

function minutesToTimeInput(minutes: number) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeInputToMinutes(value: string) {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

function AvailabilityEditor({ instructorId }: { instructorId: string }) {
  const [timezone, setTimezone] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function refresh() {
    apiFetch<{ timezone: string; rules: Rule[] }>(`/api/instructors/${instructorId}/availability-rules`).then((res) => {
      setTimezone(res.timezone);
      setRules(res.rules);
    });
  }

  useEffect(refresh, [instructorId]);

  async function addRule(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch(`/api/instructors/${instructorId}/availability-rules`, {
        method: "POST",
        body: JSON.stringify({
          dayOfWeek,
          startMinute: timeInputToMinutes(start),
          endMinute: timeInputToMinutes(end),
        }),
      });
      refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function removeRule(ruleId: string) {
    await apiFetch(`/api/instructors/${instructorId}/availability-rules/${ruleId}`, { method: "DELETE" });
    refresh();
  }

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3>Weekly availability</h3>
      <p className="dim">
        Set the hours you&apos;re generally free to teach — students book any length session inside these windows.
        Times are in your timezone{timezone ? ` (${timezone})` : ""}.
      </p>

      {DAY_NAMES.map((name, dow) => {
        const dayRules = rules.filter((r) => r.dayOfWeek === dow);
        return (
          <div key={dow} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", flexWrap: "wrap" }}>
            <span style={{ width: 90, fontSize: 13 }}>{name}</span>
            {dayRules.length === 0 && <span className="dim" style={{ fontSize: 13 }}>Unavailable</span>}
            {dayRules.map((r) => (
              <span key={r.id} className="badge" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {minutesToTimeInput(r.startMinute)}–{minutesToTimeInput(r.endMinute)}
                <button
                  type="button"
                  onClick={() => removeRule(r.id)}
                  style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0 }}
                  aria-label="Remove window"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        );
      })}

      <form onSubmit={addRule} style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 16 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Day</label>
          <select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
            {DAY_NAMES.map((name, i) => (
              <option key={i} value={i}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>From</label>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>To</label>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <button className="btn" type="submit" disabled={loading}>
          {loading ? "Adding…" : "Add window"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
