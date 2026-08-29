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

const db = require('./db');

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    description: 'Try it out — 3 chatbots, basic limits',
    stripePriceId: null,
    limits: {
      projects: 3,
      maxFiles: 5,
      storageMb: 50,
      monthlyMessages: 100,
      monthlyEmbeddingChars: 100_000,
      urlSources: 3,
    },
    // 3a — informational only (see docs/competitor-feature-implementation-plan.md
    // 3a): what an overage message would notionally cost, surfaced as a
    // usage-alert projection in services/usage.js#getUsageSnapshot. NOT
    // wired up to real Stripe metered billing/usage records — that needs a
    // metered Price object created in the Stripe dashboard plus verified
    // Billing Meters API calls, which can't be safely built or tested
    // without a live Stripe account. Free has no overage: hard-capped.
    overageRate: null,
    features: ['3 chatbots', '5 files total', '100 messages / month', 'Watermarked widget'],
  },
  {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 19,
    description: 'For solo creators and small sites',
    stripePriceId: process.env.STRIPE_PRICE_STARTER || null,
    limits: {
      projects: 3,
      maxFiles: 25,
      storageMb: 500,
      monthlyMessages: 2_000,
      monthlyEmbeddingChars: 2_000_000,
      urlSources: 25,
    },
    overageRate: 0.01,
    features: ['3 chatbots', '25 files total', '2,000 messages / month', 'No watermark', 'Email support'],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 59,
    description: 'For growing products',
    stripePriceId: process.env.STRIPE_PRICE_PRO || null,
    limits: {
      projects: 10,
      maxFiles: 100,
      storageMb: 5_000,
      monthlyMessages: 10_000,
      monthlyEmbeddingChars: 10_000_000,
      urlSources: 200,
    },
    overageRate: 0.006,
    features: ['10 chatbots', '100 files total', '10,000 messages / month', 'Custom themes', 'Priority support'],
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
      maxFiles: 500,
      storageMb: 50_000,
      monthlyMessages: 100_000,
      monthlyEmbeddingChars: 100_000_000,
      urlSources: 2_000,
    },
    overageRate: 0.004,
    features: ['50 chatbots', '500 files total', '100,000 messages / month', 'Analytics export', 'Slack/email support'],
  },
];

async function getPlan(id) {
  const stat = PLANS.find(p => p.id === id);
  if (stat) return stat;
  if (id) {
    const custom = await db.findOne('plan_tiers', { id });
    if (custom) return { id: custom.id, name: custom.name, priceMonthly: 0, limits: { ...PLANS[0].limits, ...custom.limits }, features: [], custom: true };
  }
  return PLANS[0]; // free
}

function planByStripePriceId(priceId) {
  if (!priceId) return null;
  return PLANS.find(p => p.stripePriceId === priceId) || null;
}

module.exports = { PLANS, getPlan, planByStripePriceId };
