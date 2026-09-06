"use client";

import { Suspense, useState, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password }) });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="container section" style={{ maxWidth: 420 }}>
        <h1>Reset your password</h1>
        <p className="error">This link is missing its token. Request a new one from the forgot-password page.</p>
      </div>
    );
  }

  return (
    <div className="container section" style={{ maxWidth: 420 }}>
      <h1>Choose a new password</h1>
      <form onSubmit={onSubmit} className="card">
        <div className="field">
          <label htmlFor="password">New password</label>
          <input
            id="password"
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn" type="submit" disabled={loading}>
          {loading ? "Saving…" : "Set new password"}
        </button>
      </form>
    </div>
  );
}
