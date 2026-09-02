import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const licenseTypes = await prisma.licenseType.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json({ licenseTypes });
}
