"use client";

import { Suspense, useEffect, useState, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";

interface Country {
  id: string;
  code: string;
  name: string;
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/onboarding";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [countries, setCountries] = useState<Country[]>([]);
  const [countryCode, setCountryCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch<{ countries: Country[] }>("/api/countries").then((res) => setCountries(res.countries));
  }, []);

  useEffect(() => {
    if (countries.length === 0 || countryCode) return;
    apiFetch<{ countryCode: string | null }>("/api/geo")
      .then((res) => {
        if (res.countryCode && countries.some((c) => c.code === res.countryCode)) {
          setCountryCode(res.countryCode);
        }
      })
      .catch(() => {});
  }, [countries, countryCode]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ name, email, password, countryCode: countryCode || undefined }),
      });
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container section" style={{ maxWidth: 420 }}>
      <h1>Create your account</h1>
      <form onSubmit={onSubmit} className="card">
        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="country">Country (optional)</label>
          <select id="country" value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>
            <option value="">Not sure yet</option>
            {countries.map((c) => (
              <option key={c.id} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn" type="submit" disabled={loading}>
          {loading ? "Creating account…" : "Sign up"}
        </button>
      </form>
      <p className="dim" style={{ marginTop: 12 }}>
        Already have an account? <a href={`/login?next=${encodeURIComponent(next)}`}>Log in</a>
      </p>
    </div>
  );
}
