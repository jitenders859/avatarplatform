/**
 * Subscription plans, limits, and Stripe price ID mapping.
 *
 * Limits are checked in middleware/usage.js and enforced before
 * expensive operations (file upload, message send).
 *
 * To go live with Stripe:
 *   1. Create products + recurring prices in your Stripe dashboard.
 *   2. Set the corresponding STRIPE_PRICE_* env vars (see .env.example).
 *   3. Add STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.
 *   4. Configure /api/billing/webhook in Stripe webhook endpoints.
 */

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    description: 'Try it out — 3 chatbots, basic limits',
    stripePriceId: null,
    limits: {
      projects: 29,
      filesPerProject: 5,
      storageMb: 50,
      monthlyMessages: 100,
      monthlyEmbeddingChars: 100_000,
      urlSources: 3,
    },
    features: ['3 chatbots', '5 files per chatbot', '100 messages / month', 'Watermarked widget'],
  },
  {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 19,
    description: 'For solo creators and small sites',
    stripePriceId: process.env.STRIPE_PRICE_STARTER || null,
    limits: {
      projects: 3,
      filesPerProject: 25,
      storageMb: 500,
      monthlyMessages: 2_000,
      monthlyEmbeddingChars: 2_000_000,
      urlSources: 25,
    },
    features: ['3 chatbots', '25 files each', '2,000 messages / month', 'No watermark', 'Email support'],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 59,
    description: 'For growing products',
    stripePriceId: process.env.STRIPE_PRICE_PRO || null,
    limits: {
      projects: 10,
      filesPerProject: 100,
      storageMb: 5_000,
      monthlyMessages: 10_000,
      monthlyEmbeddingChars: 10_000_000,
      urlSources: 200,
    },
    features: ['10 chatbots', '100 files each', '10,000 messages / month', 'Custom themes', 'Priority support'],
    popular: true,
  },
  {
    id: 'business',
    name: 'Business',
    priceMonthly: 199,
    description: 'For teams and agencies',
    stripePriceId: process.env.STRIPE_PRICE_BUSINESS || null,
    limits: {
      projects: 50,
      filesPerProject: 500,
      storageMb: 50_000,
      monthlyMessages: 100_000,
      monthlyEmbeddingChars: 100_000_000,
      urlSources: 2_000,
    },
    features: ['50 chatbots', '500 files each', '100,000 messages / month', 'Analytics export', 'Slack/email support'],
  },
];

function getPlan(id) {
  return PLANS.find(p => p.id === id) || PLANS[0];
}

function planByStripePriceId(priceId) {
  if (!priceId) return null;
  return PLANS.find(p => p.stripePriceId === priceId) || null;
}

module.exports = { PLANS, getPlan, planByStripePriceId };
