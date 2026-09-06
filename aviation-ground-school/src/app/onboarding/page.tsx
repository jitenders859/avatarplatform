"use client";

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";

interface Country {
  id: string;
  code: string;
  name: string;
}
interface LicenseType {
  id: string;
  code: string;
  name: string;
  description: string | null;
}
interface Chatbot {
  id: string;
  slug: string;
  title: string;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [countries, setCountries] = useState<Country[]>([]);
  const [licenseTypes, setLicenseTypes] = useState<LicenseType[]>([]);
  const [countryCode, setCountryCode] = useState("");
  const [licenseCode, setLicenseCode] = useState("");
  const [autoDetected, setAutoDetected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch<{ countries: Country[] }>("/api/countries").then((res) => setCountries(res.countries));
    apiFetch<{ licenseTypes: LicenseType[] }>("/api/license-types").then((res) => setLicenseTypes(res.licenseTypes));
  }, []);

  // Pre-select the student's country from their IP location, once we know both their
  // location and which countries we actually support — falls back to a manual pick
  // (leaves countryCode empty) if we can't detect it or don't offer it yet.
  useEffect(() => {
    if (countries.length === 0 || countryCode) return;
    apiFetch<{ countryCode: string | null }>("/api/geo")
      .then((res) => {
        if (!res.countryCode) return;
        const match = countries.find((c) => c.code === res.countryCode);
        if (match) {
          setCountryCode(match.code);
          setAutoDetected(true);
        }
      })
      .catch(() => {});
  }, [countries, countryCode]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { chatbots } = await apiFetch<{ chatbots: Chatbot[] }>(
        `/api/chatbots?country=${countryCode}&license=${licenseCode}`
      );
      const chatbot = chatbots[0];
      if (!chatbot) {
        setError("That combination isn't available yet — try another country or license.");
        return;
      }
      const { session } = await apiFetch<{ session: { id: string } }>("/api/chat/sessions", {
        method: "POST",
        body: JSON.stringify({ chatbotSlug: chatbot.slug }),
      });
      router.push(`/chat/${session.id}`);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.push(`/login?next=/onboarding`);
        return;
      }
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container section" style={{ maxWidth: 480 }}>
      <h1>Find your chatbot</h1>
      <p className="dim">Every chatbot is tuned to one country&apos;s regulator and one license type.</p>
      <form onSubmit={onSubmit} className="card" style={{ marginTop: 20 }}>
        <div className="field">
          <label htmlFor="country">Country</label>
          <select
            id="country"
            value={countryCode}
            onChange={(e) => {
              setCountryCode(e.target.value);
              setAutoDetected(false);
            }}
            required
          >
            <option value="" disabled>
              Select a country
            </option>
            {countries.map((c) => (
              <option key={c.id} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          {autoDetected && <span className="dim">Detected from your location — change it if that&apos;s wrong.</span>}
        </div>
        <div className="field">
          <label htmlFor="license">License / rating</label>
          <select id="license" value={licenseCode} onChange={(e) => setLicenseCode(e.target.value)} required>
            <option value="" disabled>
              Select a license type
            </option>
            {licenseTypes.map((l) => (
              <option key={l.id} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn" type="submit" disabled={loading || !countryCode || !licenseCode}>
          {loading ? "Loading…" : "Start chatting"}
        </button>
      </form>
    </div>
  );
}
