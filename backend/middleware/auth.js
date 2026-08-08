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
