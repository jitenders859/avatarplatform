function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  get jwtSecret() {
    return required("JWT_SECRET");
  },
  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get anthropicModel() {
    return optional("ANTHROPIC_MODEL", "claude-sonnet-5");
  },
  get stripeSecretKey() {
    return required("STRIPE_SECRET_KEY");
  },
  get stripeWebhookSecret() {
    return required("STRIPE_WEBHOOK_SECRET");
  },
  get stripeConnectWebhookSecret() {
    return required("STRIPE_CONNECT_WEBHOOK_SECRET");
  },
  get stripePriceMonthly() {
    return required("STRIPE_PRICE_MONTHLY");
  },
  get stripePriceAnnual() {
    return required("STRIPE_PRICE_ANNUAL");
  },
  get appUrl() {
    return optional("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  },
  get freeChatMessageLimit() {
    return Number(optional("FREE_CHAT_MESSAGE_LIMIT", "20"));
  },
  get freeInstructorSessionMinutes() {
    return Number(optional("FREE_INSTRUCTOR_SESSION_MINUTES", "30"));
  },
  get platformCommissionBps() {
    return Number(optional("PLATFORM_COMMISSION_BPS", "1500"));
  },
  get minSessionMinutes() {
    return Number(optional("MIN_SESSION_MINUTES", "30"));
  },
  get maxSessionMinutes() {
    return Number(optional("MAX_SESSION_MINUTES", "180"));
  },
  /** Booking durations must land on a multiple of this, e.g. 30 -> 30/60/90/120/150/180 min. */
  get sessionDurationStepMinutes() {
    return Number(optional("SESSION_DURATION_STEP_MINUTES", "30"));
  },
  /** How far in advance a student must book — no same-minute bookings. */
  get minBookingNoticeMinutes() {
    return Number(optional("MIN_BOOKING_NOTICE_MINUTES", "60"));
  },
  // --- Daily.co (video calls) — optional; booking/payment still works without it, but
  // sessions won't get a video room until this is configured. ---
  get dailyApiKey(): string | undefined {
    return process.env.DAILY_API_KEY || undefined;
  },
  // --- SMTP (transactional email) — optional; every send site checks for this and no-ops
  // with a console.warn instead of failing when it's unset (same pattern as the sibling
  // avatarplatform app in this repo). ---
  get smtpHost(): string | undefined {
    return process.env.SMTP_HOST || undefined;
  },
  get smtpPort() {
    return Number(optional("SMTP_PORT", "587"));
  },
  get smtpUser(): string | undefined {
    return process.env.SMTP_USER || undefined;
  },
  get smtpPass(): string | undefined {
    return process.env.SMTP_PASS || undefined;
  },
  get smtpFrom() {
    return optional("SMTP_FROM", "Ground School AI <no-reply@groundschool.ai>");
  },
  get appName() {
    return optional("NEXT_PUBLIC_APP_NAME", "Ground School AI");
  },
  // --- Cron (reminder emails + booking completion sweep) ---
  // Shared secret an external scheduler must send as `Authorization: Bearer <CRON_SECRET>`
  // when hitting /api/cron/*. Required in production; falls back to a dev-only default so
  // `npm run dev` doesn't need it configured.
  get cronSecret() {
    return optional("CRON_SECRET", "dev-only-cron-secret");
  },
  /** How far ahead of a session's start time to send the "starting soon" reminder. */
  get reminderLeadMinutes() {
    return Number(optional("REMINDER_LEAD_MINUTES", "15"));
  },
};
