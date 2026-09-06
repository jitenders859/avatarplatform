import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/chatbots?country=US&license=CPL
 * Returns the single matching chatbot when both filters are given, otherwise
 * the full active catalog (used to render the country/license picker).
 */
export async function GET(req: NextRequest) {
  const countryCode = req.nextUrl.searchParams.get("country");
  const licenseCode = req.nextUrl.searchParams.get("license");

  const chatbots = await prisma.chatbot.findMany({
    where: {
      isActive: true,
      country: countryCode ? { code: countryCode.toUpperCase() } : undefined,
      licenseType: licenseCode ? { code: licenseCode.toUpperCase() } : undefined,
    },
    include: { country: true, licenseType: true },
    orderBy: [{ country: { name: "asc" } }, { licenseType: { name: "asc" } }],
  });

  return NextResponse.json({ chatbots });
}
