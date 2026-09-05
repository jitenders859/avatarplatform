import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { getStripe } from "@/lib/stripe";
import { env } from "@/lib/env";

/**
 * POST /api/instructors/connect/onboarding — creates (if needed) the instructor's Stripe
 * Connect Express account and returns a fresh onboarding link. Bookings can't take
 * payment for this instructor until they complete onboarding (Instructor.connectOnboarded).
 */
export async function POST() {
  try {
    const user = await requireUser();
    const instructor = await prisma.instructor.findUnique({ where: { userId: user.id } });
    if (!instructor) {
      return NextResponse.json({ error: "Create an instructor profile first" }, { status: 404 });
    }

    const stripe = getStripe();
    let accountId = instructor.stripeConnectAccountId;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { instructorId: instructor.id, userId: user.id },
      });
      accountId = account.id;
      await prisma.instructor.update({
        where: { id: instructor.id },
        data: { stripeConnectAccountId: accountId },
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${env.appUrl}/instructor-dashboard?connect=refresh`,
      return_url: `${env.appUrl}/instructor-dashboard?connect=return`,
      type: "account_onboarding",
    });

    return NextResponse.json({ url: accountLink.url });
  } catch (err) {
    return apiError(err);
  }
}
