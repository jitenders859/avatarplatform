import { prisma } from "@/lib/db";
import { sendBookingConfirmationEmail, sendBookingReminderEmail } from "@/lib/mailer";
import { createJoinToken, JOIN_GRACE_MINUTES_AFTER } from "@/lib/video";
import { env } from "@/lib/env";

/**
 * Emails both participants once a booking becomes CONFIRMED. Idempotent via
 * `confirmationEmailSentAt` — safe to call more than once for the same booking (e.g. if a
 * Stripe webhook retries), it just no-ops after the first successful send.
 */
export async function notifyBookingConfirmed(bookingId: string): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { student: true, instructor: { include: { user: true } } },
  });
  if (!booking || booking.confirmationEmailSentAt) return;

  await Promise.all([
    sendBookingConfirmationEmail({
      to: booking.student.email,
      name: booking.student.name,
      otherPartyName: booking.instructor.user.name,
      startAt: booking.startAt,
      durationMinutes: booking.durationMinutes,
      isFreeSession: booking.isFreeSession,
      priceCents: booking.priceCents,
      currency: booking.currency,
    }),
    sendBookingConfirmationEmail({
      to: booking.instructor.user.email,
      name: booking.instructor.user.name,
      otherPartyName: booking.student.name,
      startAt: booking.startAt,
      durationMinutes: booking.durationMinutes,
      isFreeSession: booking.isFreeSession,
      priceCents: booking.instructorPayoutCents,
      currency: booking.currency,
    }),
  ]);

  await prisma.booking.update({ where: { id: booking.id }, data: { confirmationEmailSentAt: new Date() } });
}

/**
 * Sends "starting soon" reminders (with a ready-to-use join link) for confirmed bookings
 * whose start time falls inside the reminder lead window and haven't been reminded yet.
 * Meant to be called periodically by /api/cron/reminders, not from user-facing request paths.
 */
export async function sendDueReminders(): Promise<number> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + env.reminderLeadMinutes * 60_000);

  const due = await prisma.booking.findMany({
    where: {
      status: "CONFIRMED",
      reminderSentAt: null,
      startAt: { gte: now, lte: windowEnd },
    },
    include: { student: true, instructor: { include: { user: true } } },
  });

  for (const booking of due) {
    const closesAt = new Date(booking.endAt.getTime() + JOIN_GRACE_MINUTES_AFTER * 60_000);

    let studentJoinUrl = `${env.appUrl}/session/${booking.id}`;
    let instructorJoinUrl = studentJoinUrl;
    if (booking.dailyRoomName && booking.dailyRoomUrl) {
      try {
        const [studentToken, instructorToken] = await Promise.all([
          createJoinToken(booking.dailyRoomName, { userName: booking.student.name, isOwner: false, exp: closesAt }),
          createJoinToken(booking.dailyRoomName, { userName: booking.instructor.user.name, isOwner: true, exp: closesAt }),
        ]);
        studentJoinUrl = `${booking.dailyRoomUrl}?t=${studentToken}`;
        instructorJoinUrl = `${booking.dailyRoomUrl}?t=${instructorToken}`;
      } catch (err) {
        console.error("Failed to mint join tokens for reminder", booking.id, err);
      }
    }

    await Promise.all([
      sendBookingReminderEmail({
        to: booking.student.email,
        name: booking.student.name,
        otherPartyName: booking.instructor.user.name,
        startAt: booking.startAt,
        joinUrl: studentJoinUrl,
      }),
      sendBookingReminderEmail({
        to: booking.instructor.user.email,
        name: booking.instructor.user.name,
        otherPartyName: booking.student.name,
        startAt: booking.startAt,
        joinUrl: instructorJoinUrl,
      }),
    ]);

    await prisma.booking.update({ where: { id: booking.id }, data: { reminderSentAt: new Date() } });
  }

  return due.length;
}

/** Moves any CONFIRMED booking whose session is over into COMPLETED. Safe to call repeatedly. */
export async function completeExpiredBookings(): Promise<number> {
  const result = await prisma.booking.updateMany({
    where: { status: "CONFIRMED", endAt: { lt: new Date() } },
    data: { status: "COMPLETED" },
  });
  return result.count;
}
