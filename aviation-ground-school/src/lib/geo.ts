import { NextRequest } from "next/server";

/**
 * Best-effort IP geolocation using headers set by common hosts — no external geo API call,
 * no browser permission prompt. Works out of the box on Vercel (`x-vercel-ip-country`) and
 * Cloudflare (`cf-ipcountry`); returns null in local dev or anywhere else that doesn't set
 * one of these, and the frontend just falls back to asking the student to pick manually.
 */
export function detectCountryCode(req: NextRequest): string | null {
  const vercelGeoCountry = (req as unknown as { geo?: { country?: string } }).geo?.country;

  const candidates = [
    vercelGeoCountry,
    req.headers.get("x-vercel-ip-country"),
    req.headers.get("cf-ipcountry"),
    req.headers.get("x-appengine-country"),
  ];

  const code = candidates.find((c) => c && /^[A-Za-z]{2}$/.test(c) && c.toUpperCase() !== "XX" && c.toUpperCase() !== "T1");

  return code ? code.toUpperCase() : null;
}
