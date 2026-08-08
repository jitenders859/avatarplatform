/**
 * Resolves which Socket.IO room a connecting client may join, from a
 * verified JWT rather than a client-supplied user id.
 *
 * Vulnerability this replaces: server.js used to do
 * `socket.on('join', userId => socket.join('user:' + userId))` — any
 * connected client (authenticated or not) could pass ANY user's id as the
 * `userId` argument and be joined to that user's room, then receive their
 * private `file:progress` events (fileId, processing stage/%). Room
 * membership is now derived solely from the same JWT already used for REST
 * API calls, so a client can only ever join its own room.
 */
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./middleware/auth');

/**
 * @param {string} token - Bearer JWT, same one sent as Authorization on API calls
 * @returns {string|null} 'user:<uid>' room name, or null if the token is
 *   missing, malformed, expired, or signed with the wrong secret
 */
function resolveUserRoom(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || !payload.uid) return null;
    return `user:${payload.uid}`;
  } catch {
    return null;
  }
}

module.exports = { resolveUserRoom };
