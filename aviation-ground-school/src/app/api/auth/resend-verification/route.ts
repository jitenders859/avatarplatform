import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, generateToken } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { sendVerificationEmail } from "@/lib/mailer";

/** POST /api/auth/resend-verification — for a signed-in user whose email isn't verified yet. */
export async function POST() {
  try {
    const user = await requireUser();
    if (user.emailVerified) {
      return NextResponse.json({ error: "Already verified" }, { status: 409 });
    }

    const token = generateToken();
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerificationToken: token, emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    await sendVerificationEmail(user.email, user.name, token);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
