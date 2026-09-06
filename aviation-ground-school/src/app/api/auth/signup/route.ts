import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword, setSessionCookie, generateToken } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { sendVerificationEmail } from "@/lib/mailer";

const bodySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  countryCode: z.string().length(2).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = bodySchema.parse(await req.json());

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return NextResponse.json({ error: "An account with that email already exists" }, { status: 409 });
    }

    const country = body.countryCode
      ? await prisma.country.findUnique({ where: { code: body.countryCode } })
      : null;

    const verificationToken = generateToken();

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        countryId: country?.id,
        emailVerificationToken: verificationToken,
        emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    await setSessionCookie({ userId: user.id, role: user.role });
    sendVerificationEmail(user.email, user.name, verificationToken).catch((err) =>
      console.error("Failed to send verification email", err)
    );

    return NextResponse.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
