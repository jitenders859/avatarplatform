import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword, setSessionCookie } from "@/lib/auth";
import { apiError } from "@/lib/api";

const bodySchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});

/** POST /api/auth/reset-password — consumes a forgot-password token, sets the new password, logs the user in. */
export async function POST(req: NextRequest) {
  try {
    const body = bodySchema.parse(await req.json());

    const user = await prisma.user.findUnique({ where: { passwordResetToken: body.token } });
    if (!user || !user.passwordResetExpires || user.passwordResetExpires.getTime() < Date.now()) {
      return NextResponse.json({ error: "This reset link is invalid or has expired" }, { status: 400 });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(body.password),
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    await setSessionCookie({ userId: user.id, role: user.role });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
