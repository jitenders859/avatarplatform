/**
 * Coupon system — a Stripe Coupon + Promotion Code pair is the source of
 * truth for the discount itself, but redemption enforcement (total and
 * per-user caps, applicable-tier restriction) is ours: Stripe's hosted
 * checkout page can't enforce a per-user cap, and this app's plans are
 * keyed by Price ID rather than Product ID, so Stripe's native
 * applies_to.products restriction doesn't map cleanly onto them anyway.
 *
 * Redemptions are only recorded for codes redeemed through our own
 * pre-checkout validation (routes/billing.js's create-checkout-session
 * passing couponCode) — see recordRedemptionFromCheckoutSession below. A
 * customer who instead types an arbitrary Stripe promotion code directly
 * into Stripe's own hosted checkout page (the allow_promotion_codes
 * fallback, used when no couponCode is passed) is enforced by Stripe's own
 * native redemption limit on the Promotion Code object, not tracked here —
 * this is the explicit, disclosed tradeoff of choosing custom pre-checkout
 * validation as the primary path over pure Stripe self-serve.
 */
const crypto = require('crypto');
const db = require('../db');
const { getStripe } = require('./stripe');

// Avoids visually ambiguous characters (0/O, 1/I/L) in auto-generated codes.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

async function createCoupon(input) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Billing is not configured on this server (STRIPE_SECRET_KEY missing).');

  const code = (input.code || generateCode()).trim().toUpperCase();
  const existing = await db.findOne('coupons', { code });
  if (existing) throw new Error('A coupon with that code already exists');

  const couponParams = {
    // "once" = applies to the customer's first invoice only, the standard
    // meaning of a promo/coupon code for a subscription signup — not
    // exposed as an admin option since the spec didn't call for it.
    duration: 'once',
  };
  if (input.discountType === 'percent') {
    couponParams.percent_off = input.discountValue;
  } else {
    couponParams.amount_off = Math.round(input.discountValue);
    couponParams.currency = input.currency;
  }
  if (input.maxRedemptions) couponParams.max_redemptions = input.maxRedemptions;
  const stripeCoupon = await stripe.coupons.create(couponParams);

  let promo;
  try {
    const promoParams = { coupon: stripeCoupon.id, code };
    if (input.maxRedemptions) promoParams.max_redemptions = input.maxRedemptions;
    if (input.expiresAt) promoParams.expires_at = Math.floor(input.expiresAt / 1000);
    promo = await stripe.promotionCodes.create(promoParams);
  } catch (e) {
    await stripe.coupons.del(stripeCoupon.id).catch(() => {});
    throw e;
  }

  // Roll back the live Stripe objects on a DB-layer failure — without this,
  // a failed insert leaves an orphaned, fully live and redeemable coupon in
  // Stripe that no local row tracks or enforces caps for (hit this for real
  // during development: a pre-existing serialization bug in db.js rejected
  // the insert after both Stripe objects had already been created).
  try {
    return await db.insert('coupons', {
      id: crypto.randomUUID(),
      code,
      stripeCouponId: stripeCoupon.id,
      stripePromotionCodeId: promo.id,
      discountType: input.discountType,
      discountValue: input.discountValue,
      currency: input.discountType === 'fixed' ? input.currency : null,
      applicablePlanIds: input.applicablePlanIds || [],
      maxRedemptions: input.maxRedemptions || null,
      maxRedemptionsPerUser: input.maxRedemptionsPerUser || null,
      expiresAt: input.expiresAt || null,
      active: true,
      createdBy: input.createdBy,
      createdAt: Date.now(),
    });
  } catch (e) {
    await stripe.promotionCodes.update(promo.id, { active: false }).catch(() => {});
    await stripe.coupons.del(stripeCoupon.id).catch(() => {});
    throw e;
  }
}

async function setCouponActive(couponRow, active) {
  const stripe = getStripe();
  if (stripe) {
    await stripe.promotionCodes.update(couponRow.stripePromotionCodeId, { active });
  }
  return db.update('coupons', couponRow.id, { active });
}

// Hard delete is only safe for a never-used coupon — deleting a redeemed
// one would sever coupon_redemptions' FK context and erase revenue/audit
// history, so this blocks with a 409-flagged error instead (mirrors the
// tier-delete in-use guard at admin.js's DELETE /tiers/:tierId). Stripe has
// no "delete" for a Promotion Code, only deactivation, so — like
// setCouponActive(false) — this revokes it via promotionCodes.update
// rather than inventing an unsupported delete call.
async function deleteCoupon(couponRow) {
  const { count } = await db.queryOne(
    'SELECT COUNT(*)::int AS count FROM coupon_redemptions WHERE coupon_id = $1',
    [couponRow.id]
  );
  if (count > 0) {
    const err = new Error('This coupon has been redeemed and cannot be deleted');
    err.status = 409;
    throw err;
  }
  const stripe = getStripe();
  if (stripe) {
    await stripe.promotionCodes.update(couponRow.stripePromotionCodeId, { active: false }).catch(() => {});
  }
  await db.remove('coupons', { id: couponRow.id });
}

// Shared by the admin coupon list (informational) and billing.js's
// pre-checkout check (authoritative — never trust a client-reported code
// as valid without re-running this here).
async function validateCoupon(code, planId, userId) {
  const coupon = await db.findOne('coupons', { code: String(code || '').trim().toUpperCase() });
  if (!coupon) return { valid: false, reason: 'Invalid coupon code' };
  if (!coupon.active) return { valid: false, reason: 'This coupon is no longer active' };
  if (coupon.expiresAt && coupon.expiresAt < Date.now()) return { valid: false, reason: 'This coupon has expired' };
  if (coupon.applicablePlanIds?.length && !coupon.applicablePlanIds.includes(planId)) {
    return { valid: false, reason: 'This coupon is not valid for the selected plan' };
  }
  if (coupon.maxRedemptions != null) {
    const total = await db.queryOne('SELECT COUNT(*)::int AS count FROM coupon_redemptions WHERE coupon_id = $1', [coupon.id]);
    if (total.count >= coupon.maxRedemptions) return { valid: false, reason: 'This coupon has reached its redemption limit' };
  }
  if (coupon.maxRedemptionsPerUser != null && userId) {
    const perUser = await db.queryOne('SELECT COUNT(*)::int AS count FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2', [coupon.id, userId]);
    if (perUser.count >= coupon.maxRedemptionsPerUser) return { valid: false, reason: 'You have already used this coupon' };
  }
  return { valid: true, coupon };
}

function findByStripePromotionCodeId(stripePromotionCodeId) {
  return db.findOne('coupons', { stripePromotionCodeId });
}

async function recordRedemption({ couponId, userId, stripeCheckoutSessionId, planId }) {
  await db.insert('coupon_redemptions', {
    id: crypto.randomUUID(),
    couponId,
    userId,
    stripeCheckoutSessionId: stripeCheckoutSessionId || null,
    planId: planId || null,
    redeemedAt: Date.now(),
  });
}

module.exports = { createCoupon, setCouponActive, deleteCoupon, validateCoupon, findByStripePromotionCodeId, recordRedemption };
