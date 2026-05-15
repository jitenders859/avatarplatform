const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please';

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.findOne('users', u => u.id === payload.uid);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' });
}

module.exports = { authRequired, signToken, JWT_SECRET };
