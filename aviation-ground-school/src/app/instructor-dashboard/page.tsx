"use client";

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";

interface Me {
  id: string;
  name: string;
  isInstructor: boolean;
  instructor: { id: string; connectOnboarded: boolean; hourlyRateCents: number } | null;
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

export default function InstructorDashboardPage() {
  const router = useRouter();
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

  useEffect(() => {
    refreshMe();
    apiFetch<{ countries: Country[] }>("/api/countries").then((res) => setCountries(res.countries));
    apiFetch<{ licenseTypes: LicenseType[] }>("/api/license-types").then((res) => setLicenseTypes(res.licenseTypes));
    apiFetch<{ asInstructor: BookingRow[] }>("/api/bookings")
      .then((res) => setBookings(res.asInstructor))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (me === undefined) return null;

  return (
    <div className="container section">
      <h1>Teaching on Ground School AI</h1>

      {!me?.isInstructor && (
        <BecomeInstructorForm countries={countries} licenseTypes={licenseTypes} onDone={refreshMe} />
      )}

      {me?.isInstructor && !me.instructor?.connectOnboarded && <ConnectOnboardingCard />}

      {me?.isInstructor && me.instructor?.connectOnboarded && me.instructor && (
        <SlotForm instructorId={me.instructor.id} />
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
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id}>
                    <td>{b.student.name}</td>
                    <td>{new Date(b.startAt).toLocaleString()}</td>
                    <td>{b.status}</td>
                    <td>{b.isFreeSession ? "Free session" : `$${(b.instructorPayoutCents / 100).toFixed(2)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function BecomeInstructorForm({
  countries,
  licenseTypes,
  onDone,
}: {
  countries: Country[];
  licenseTypes: LicenseType[];
  onDone: () => void;
}) {
  const [hourlyRate, setHourlyRate] = useState(75);
  const [bio, setBio] = useState("");
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [selectedLicenses, setSelectedLicenses] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function toggle(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/instructors", {
        method: "POST",
        body: JSON.stringify({
          hourlyRateCents: Math.round(hourlyRate * 100),
          bio,
          countryCodes: selectedCountries,
          licenseTypeCodes: selectedLicenses,
        }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card" style={{ marginTop: 20 }}>
      <h3>Become an instructor</h3>
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
      {error && <p className="error">{error}</p>}
      <button className="btn" type="submit" disabled={loading || selectedCountries.length === 0 || selectedLicenses.length === 0}>
        {loading ? "Saving…" : "Create instructor profile"}
      </button>
    </form>
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

function SlotForm({ instructorId }: { instructorId: string }) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);
    try {
      await apiFetch(`/api/instructors/${instructorId}/slots`, {
        method: "POST",
        body: JSON.stringify({ startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() }),
      });
      setSuccess(true);
      setStart("");
      setEnd("");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card" style={{ marginTop: 20 }}>
      <h3>Open a bookable time slot</h3>
      <div className="field">
        <label>Start</label>
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
      </div>
      <div className="field">
        <label>End</label>
        <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
      </div>
      {error && <p className="error">{error}</p>}
      {success && <p className="dim">Slot added.</p>}
      <button className="btn" type="submit" disabled={loading}>
        {loading ? "Adding…" : "Add slot"}
      </button>
    </form>
  );
}
