"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";

export default function BookSlotButton({ slotId }: { slotId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function book() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ checkoutUrl: string | null }>("/api/bookings", {
        method: "POST",
        body: JSON.stringify({ slotId }),
      });
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        router.push("/dashboard?booking=success");
        router.refresh();
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.push("/login?next=/instructors");
        return;
      }
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div>
      <button className="btn" onClick={book} disabled={loading}>
        {loading ? "Booking…" : "Book this slot"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
