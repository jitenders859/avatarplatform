/**
 * Billing routes — plans listing, Stripe checkout / portal / webhook.
 *
 * The webhook endpoint (POST /webhook) needs the *raw* body for
 * signature verification, so it's mounted with express.raw() in
 * server.js BEFORE the global JSON parser.
 */
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { PLANS, getPlan, planByStripePriceId } = require('../plans');
const { getStripe, isConfigured } = require('../services/stripe');
const { getUsageSnapshot, userPlanId } = require('../services/usage');
const logger = require('../logger').child({ module: 'billing' });

const router = express.Router();

// ── Public: list plans ────────────────────────────────────────
router.get('/plans', (_req, res) => {
  res.json({
    plans: PLANS.map(p => ({
      id: p.id,
      name: p.name,
      priceMonthly: p.priceMonthly,
      description: p.description,
      features: p.features,
      limits: p.limits,
      popular: !!p.popular,
      hasStripe: !!p.stripePriceId,
    })),
    stripeEnabled: isConfigured(),
  });
});

// ── Authenticated: subscription + usage ───────────────────────
router.get('/subscription', authRequired, async (req, res) => {
  const planId = await userPlanId(req.user.id);
  const plan = getPlan(planId);
  const sub = await db.findOne('subscriptions', { userId: req.user.id, status: 'active' });
  res.json({
    plan: { id: plan.id, name: plan.name, priceMonthly: plan.priceMonthly },
    subscription: sub ? {
      id: sub.id,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    } : null,
  });
});

router.get('/usage', authRequired, async (req, res) => {
  res.json(await getUsageSnapshot(req.user.id));
});

// ── Stripe Checkout session ───────────────────────────────────
router.post('/create-checkout-session', authRequired, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured on this server (STRIPE_SECRET_KEY missing).' });

  const { planId } = req.body || {};
  const plan = getPlan(planId);
  if (!plan || plan.id === 'free') return res.status(400).json({ error: 'Invalid plan' });
  if (!plan.stripePriceId) return res.status(400).json({ error: `No Stripe price configured for plan "${plan.id}"` });

  const user = await db.findOne('users', { id: req.user.id });
  if (!user) return res.status(404).json({ error: 'User not found' });

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    await db.update('users', user.id, { stripeCustomerId: customerId });
  }

  const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: `${origin}/billing?status=success`,
    cancel_url:  `${origin}/billing?status=cancelled`,
    metadata: { userId: user.id, planId: plan.id },
    subscription_data: { metadata: { userId: user.id, planId: plan.id } },
    allow_promotion_codes: true,
  });

  res.json({ url: session.url });
});

// ── Stripe Customer Portal session ────────────────────────────
router.post('/create-portal-session', authRequired, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured.' });

  const user = await db.findOne('users', { id: req.user.id });
  if (!user || !user.stripeCustomerId) {
    return res.status(400).json({ error: 'No Stripe customer for this user yet — start a checkout first.' });
  }

  const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${origin}/billing`,
  });
  res.json({ url: session.url });
});

// ── Webhook (raw body — see server.js mount) ──────────────────
async function webhookHandler(req, res) {
  const stripe = getStripe();
  if (!stripe) return res.status(503).end();

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('STRIPE_WEBHOOK_SECRET missing — refusing event');
    return res.status(500).end();
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    logger.error({ err: err.message }, 'webhook signature verify failed');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await syncSubscriptionFromEvent(event, stripe);
        break;
      case 'customer.subscription.deleted':
        await markSubscriptionCancelled(event);
        break;
    }
  } catch (e) {
    logger.error({ err: e }, 'webhook handler error');
    return res.status(500).end();
  }

  res.json({ received: true });
}

async function syncSubscriptionFromEvent(event, stripe) {
  const obj = event.data.object;
  let subscription = obj;

  if (event.type === 'checkout.session.completed') {
    if (!obj.subscription) return;
    subscription = await stripe.subscriptions.retrieve(obj.subscription);
  }

  const userId = subscription.metadata?.userId
    || (event.type === 'checkout.session.completed' ? obj.metadata?.userId : null);
  if (!userId) {
    logger.warn({ subscriptionId: subscription.id }, 'no userId in subscription metadata; skipping');
    return;
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = planByStripePriceId(priceId);
  const planId = plan ? plan.id : (subscription.metadata?.planId || 'starter');

  // Remove old active subscription for this user, then insert fresh row
  await db.remove('subscriptions', { userId, status: 'active' });

  await db.insert('subscriptions', {
    id: subscription.id,
    userId,
    planId,
    status: subscription.status === 'active' || subscription.status === 'trialing' ? 'active' : subscription.status,
    stripeCustomerId: subscription.customer,
    stripePriceId: priceId,
    currentPeriodEnd: subscription.current_period_end ? subscription.current_period_end * 1000 : null,
    cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
    createdAt: Date.now(),
  });
  logger.info({ subscriptionId: subscription.id, userId, planId }, 'synced subscription');
}

async function markSubscriptionCancelled(event) {
  const sub = event.data.object;
  const row = await db.findOne('subscriptions', { id: sub.id });
  if (row) await db.update('subscriptions', row.id, { status: 'cancelled' });
}

module.exports = { router, webhookHandler };
