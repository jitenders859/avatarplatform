import { NextRequest, NextResponse } from "next/server";
import { detectCountryCode } from "@/lib/geo";

export const dynamic = "force-dynamic";

/** GET /api/geo — best-guess country code for the requester, used to pre-select the onboarding country. */
export async function GET(req: NextRequest) {
  return NextResponse.json({ countryCode: detectCountryCode(req) });
}
