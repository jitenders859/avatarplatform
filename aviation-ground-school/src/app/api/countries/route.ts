import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const countries = await prisma.country.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json({ countries });
}
