const jwt = require('jsonwebtoken');
const db = require('../db');

// Previously fell back to a hardcoded secret ('change-me-in-production-please')
// whenever JWT_SECRET was unset, so any deployment that lost/forgot the env
// var would silently sign and verify tokens with a secret sitting in source
// control — anyone could forge a valid token for any user id. Fail fast
// instead: refuse to boot rather than run with a known, guessable secret.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required and must not be empty');
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.findOne('users', { id: payload.uid });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.suspended) return res.status(403).json({ error: 'This account has been suspended' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function signToken(userId, opts = {}) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: opts.expiresIn || '30d' });
}

// Admin auth is structurally disjoint from customer auth: admin tokens carry
// {aid, isAdmin: true} (no uid) and are checked against the separate
// admin_users table, so a customer token can never satisfy this middleware
// and an admin token can never satisfy authRequired above (it has no uid,
// so db.findOne('users', {id: undefined}) returns null → 401).
async function adminAuthRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing admin auth token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.isAdmin) return res.status(401).json({ error: 'Invalid admin token' });
    const admin = await db.findOne('admin_users', { id: payload.aid });
    if (!admin) return res.status(401).json({ error: 'Admin not found' });
    req.admin = admin;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

function signAdminToken(adminId) {
  return jwt.sign({ aid: adminId, isAdmin: true }, JWT_SECRET, { expiresIn: '12h' });
}

module.exports = { authRequired, signToken, adminAuthRequired, signAdminToken, JWT_SECRET };
