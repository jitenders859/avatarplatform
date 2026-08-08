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
  const user = await db.findOne('users', { id: req.user.id });
  const activeSub = await db.findOne('subscriptions', { userId: req.user.id, status: 'active' });
  // Most recent subscription of any status — lets a churned user still see
  // "Manage billing" (invoice history, resubscribe) even after cancellation,
  // instead of losing access to the portal the moment status flips.
  const rows = await db.query(
    `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [req.user.id]
  );
  const latestSub = rows[0] || null;

  res.json({
    plan: { id: plan.id, name: plan.name, priceMonthly: plan.priceMonthly },
    subscription: activeSub ? {
      id: activeSub.id,
      status: activeSub.status,
      currentPeriodEnd: activeSub.currentPeriodEnd,
      cancelAtPeriodEnd: !!activeSub.cancelAtPeriodEnd,
    } : (latestSub ? { id: latestSub.id, status: latestSub.status, currentPeriodEnd: latestSub.currentPeriodEnd, cancelAtPeriodEnd: !!latestSub.cancelAtPeriodEnd } : null),
    // Whether Manage Billing can work at all — true once a Stripe customer
    // exists for this user, even if they have no subscription right now.
    hasStripeCustomer: !!(user && user.stripeCustomerId) || !!(latestSub && latestSub.stripeCustomerId),
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
  if (!user) return res.status(404).json({ error: 'User not found' });

  let customerId = user.stripeCustomerId;

  // Self-heal: the subscriptions table is the source of truth for what
  // Stripe actually did (populated by the webhook). If users.stripe_customer_id
  // is missing — e.g. an older row from before this column was backfilled
  // consistently, or a write that landed on the subscription but not the
  // user — recover the customer id from there instead of dead-ending.
  if (!customerId) {
    const rows = await db.query(
      `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1 AND stripe_customer_id IS NOT NULL
       ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [user.id]
    );
    customerId = rows[0]?.stripeCustomerId || null;
    if (customerId) await db.update('users', user.id, { stripeCustomerId: customerId });
  }

  if (!customerId) {
    return res.status(400).json({
      error: 'You haven\'t subscribed to a paid plan yet — choose a plan to get started.',
      code: 'no_customer',
    });
  }

  const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
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
  const status = subscription.status === 'active' || subscription.status === 'trialing' ? 'active' : subscription.status;
  const now = Date.now();

  // Upsert keyed by Stripe subscription id (the row's primary key) instead
  // of remove-then-insert. Stripe delivers webhooks "at least once", so the
  // same event (or checkout.session.completed + customer.subscription.created
  // for one checkout) can arrive concurrently — a remove+insert pair races
  // on the primary key in that case and one delivery fails with a duplicate
  // key error. ON CONFLICT makes this convergent no matter how many times
  // or in what order duplicate deliveries land.
  await db.query(
    `INSERT INTO subscriptions
       (id, user_id, plan_id, status, stripe_customer_id, stripe_price_id, current_period_end, cancel_at_period_end, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (id) DO UPDATE SET
       plan_id = $3, status = $4, stripe_customer_id = $5, stripe_price_id = $6,
       current_period_end = $7, cancel_at_period_end = $8, updated_at = $9`,
    [
      subscription.id, userId, planId, status,
      subscription.customer, priceId,
      subscription.current_period_end ? subscription.current_period_end * 1000 : null,
      !!subscription.cancel_at_period_end,
      now,
    ]
  );

  // A user should have at most one active subscription. If this event is a
  // plan switch that created a brand-new Stripe subscription (rather than
  // updating the existing one), retire the old row now that the new one is
  // safely upserted.
  if (status === 'active') {
    await db.query(
      `DELETE FROM subscriptions WHERE user_id = $1 AND status = 'active' AND id != $2`,
      [userId, subscription.id]
    );
  }

  // Root-cause fix for "No Stripe customer for this user yet" on Manage
  // Billing: whatever created this subscription is proof a Stripe customer
  // exists, so keep users.stripe_customer_id in sync here rather than only
  // at checkout-session creation. Covers subscriptions created outside our
  // own /create-checkout-session flow (Stripe dashboard, payment links,
  // retried checkouts where the earlier DB write didn't land).
  if (subscription.customer) {
    await db.query(
      `UPDATE users SET stripe_customer_id = $2 WHERE id = $1 AND (stripe_customer_id IS NULL OR stripe_customer_id != $2)`,
      [userId, subscription.customer]
    );
  }

  logger.info({ subscriptionId: subscription.id, userId, planId }, 'synced subscription');
}

async function markSubscriptionCancelled(event) {
  const sub = event.data.object;
  const row = await db.findOne('subscriptions', { id: sub.id });
  if (row) await db.update('subscriptions', row.id, { status: 'cancelled' });
}

module.exports = { router, webhookHandler };
