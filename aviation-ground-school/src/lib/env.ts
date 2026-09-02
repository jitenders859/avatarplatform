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
};
