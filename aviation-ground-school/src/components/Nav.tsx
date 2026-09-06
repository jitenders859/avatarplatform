"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";

interface Me {
  id: string;
  name: string;
  role: "STUDENT" | "INSTRUCTOR" | "ADMIN";
  isInstructor: boolean;
}

export default function Nav() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const router = useRouter();

  useEffect(() => {
    apiFetch<{ user: Me | null }>("/api/auth/me")
      .then((res) => setMe(res.user))
      .catch(() => setMe(null));
  }, []);

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    setMe(null);
    router.push("/");
    router.refresh();
  }

  return (
    <nav className="nav">
      <div className="container">
        <Link href="/" className="brand">
          ✈ Ground School AI
        </Link>
        <div className="nav-links">
          <Link href="/onboarding">Chat with a bot</Link>
          <Link href="/instructors">Instructors</Link>
          <Link href="/pricing">Pricing</Link>
          {me === undefined ? null : me ? (
            <>
              <Link href="/dashboard">Dashboard</Link>
              {me.isInstructor && <Link href="/instructor-dashboard">Teaching</Link>}
              {me.role === "ADMIN" && <Link href="/admin">Admin</Link>}
              <button className="btn btn-secondary" onClick={logout}>
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login">Log in</Link>
              <Link href="/signup" className="btn">
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
