/**
 * Admin coupon management — create/list/deactivate coupons (Stripe Coupon +
 * Promotion Code pairs, see services/coupons.js) and view redemption
 * history. Redemption CAP enforcement happens in routes/billing.js at
 * checkout time, not here — this is management/visibility only.
 */
const express = require('express');
const db = require('../db');
const { adminAuthRequired } = require('../middleware/auth');
const { logAdminAction } = require('../services/auditLog');
const { validate, schemas } = require('../middleware/validate');
const coupons = require('../services/coupons');

const router = express.Router();
router.use(adminAuthRequired);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Coupon not found' });
  next();
});

router.get('/', async (req, res) => {
  const rows = await db.query(
    `SELECT c.*, COUNT(r.id)::int AS redemption_count
       FROM coupons c
       LEFT JOIN coupon_redemptions r ON r.coupon_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC`
  );
  res.json({
    coupons: rows.map(c => ({
      ...c,
      remainingRedemptions: c.maxRedemptions != null ? Math.max(0, c.maxRedemptions - c.redemptionCount) : null,
    })),
  });
});

router.post('/', validate(schemas.couponCreate), async (req, res) => {
  try {
    const coupon = await coupons.createCoupon({ ...req.body, createdBy: req.admin.id });
    await logAdminAction({
      adminId: req.admin.id,
      action: 'coupon_create',
      meta: { couponId: coupon.id, code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue },
    });
    res.json({ coupon });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', validate(schemas.couponPatch), async (req, res) => {
  const existing = await db.findOne('coupons', { id: req.params.id });
  if (!existing) return res.status(404).json({ error: 'Coupon not found' });

  const { active, ...localPatch } = req.body;
  try {
    let updated = existing;
    if (Object.keys(localPatch).length) {
      updated = await db.update('coupons', existing.id, localPatch);
    }
    if (active !== undefined && active !== existing.active) {
      updated = await coupons.setCouponActive(updated, active);
      await logAdminAction({
        adminId: req.admin.id,
        action: active ? 'coupon_activate' : 'coupon_deactivate',
        meta: { couponId: existing.id, code: existing.code },
      });
    } else if (Object.keys(localPatch).length) {
      await logAdminAction({
        adminId: req.admin.id,
        action: 'coupon_update',
        meta: { couponId: existing.id, code: existing.code, patch: localPatch },
      });
    }
    res.json({ coupon: updated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id/redemptions', async (req, res) => {
  const existing = await db.findOne('coupons', { id: req.params.id });
  if (!existing) return res.status(404).json({ error: 'Coupon not found' });
  const redemptions = await db.query(
    `SELECT r.id, r.user_id, r.plan_id, r.redeemed_at, u.email
       FROM coupon_redemptions r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.coupon_id = $1
      ORDER BY r.redeemed_at DESC`,
    [req.params.id]
  );
  res.json({ redemptions });
});

module.exports = router;
