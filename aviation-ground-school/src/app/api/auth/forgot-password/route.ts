import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { generateToken } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { sendPasswordResetEmail } from "@/lib/mailer";

const bodySchema = z.object({ email: z.string().email() });

/**
 * POST /api/auth/forgot-password — always returns 200 regardless of whether the email
 * exists, so this endpoint can't be used to enumerate registered accounts.
 */
export async function POST(req: NextRequest) {
  try {
    const { email } = bodySchema.parse(await req.json());

    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const token = generateToken();
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordResetToken: token, passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000) },
      });
      sendPasswordResetEmail(user.email, user.name, token).catch((err) =>
        console.error("Failed to send password reset email", err)
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
