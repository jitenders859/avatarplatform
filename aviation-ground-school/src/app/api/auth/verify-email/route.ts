import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

/** GET /api/auth/verify-email?token=... — one-click verification link from the email; redirects either way. */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.redirect(`${env.appUrl}/dashboard?verified=missing`);
  }

  const user = await prisma.user.findUnique({ where: { emailVerificationToken: token } });
  if (!user || !user.emailVerificationExpires || user.emailVerificationExpires.getTime() < Date.now()) {
    return NextResponse.redirect(`${env.appUrl}/dashboard?verified=expired`);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: true, emailVerificationToken: null, emailVerificationExpires: null },
  });

  return NextResponse.redirect(`${env.appUrl}/dashboard?verified=1`);
}
