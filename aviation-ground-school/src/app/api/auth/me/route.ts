import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ user: null });
  }
  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      country: user.country?.code ?? null,
      subscriptionStatus: user.subscription?.status ?? null,
      isInstructor: user.instructor !== null,
      instructor: user.instructor
        ? {
            id: user.instructor.id,
            connectOnboarded: user.instructor.connectOnboarded,
            hourlyRateCents: user.instructor.hourlyRateCents,
          }
        : null,
    },
  });
}
