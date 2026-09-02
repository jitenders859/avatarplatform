"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";

export default function PricingPage() {
  const router = useRouter();
  const [loadingPlan, setLoadingPlan] = useState<"MONTHLY" | "ANNUAL" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function subscribe(plan: "MONTHLY" | "ANNUAL") {
    setError(null);
    setLoadingPlan(plan);
    try {
      const { url } = await apiFetch<{ url: string }>("/api/subscriptions/checkout", {
        method: "POST",
        body: JSON.stringify({ plan }),
      });
      window.location.href = url;
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.push("/login?next=/pricing");
        return;
      }
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
      setLoadingPlan(null);
    }
  }

  return (
    <div className="container section">
      <h1>Pricing</h1>
      <p className="dim">
        Every plan unlocks unlimited chatbot access across every country and license. Instructor sessions are billed
        separately, per session — no subscription required for those.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="grid grid-2" style={{ marginTop: 24 }}>
        <div className="card">
          <h3>Monthly</h3>
          <p className="dim">Unlimited ground-school chatbot access, billed monthly.</p>
          <button className="btn" onClick={() => subscribe("MONTHLY")} disabled={loadingPlan !== null}>
            {loadingPlan === "MONTHLY" ? "Redirecting…" : "Subscribe monthly"}
          </button>
        </div>
        <div className="card">
          <h3>Annual</h3>
          <span className="badge">Best value</span>
          <p className="dim">Unlimited ground-school chatbot access, billed annually.</p>
          <button className="btn" onClick={() => subscribe("ANNUAL")} disabled={loadingPlan !== null}>
            {loadingPlan === "ANNUAL" ? "Redirecting…" : "Subscribe annually"}
          </button>
        </div>
      </div>
    </div>
  );
}
