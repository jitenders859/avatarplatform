const { LRUCache } = require('lru-cache');

// Shared project config cache — keyed by publicId, 1 min TTL.
// Lives outside embed.js so projects.js can invalidate without a circular import.
const projectCache = new LRUCache({ max: 500, ttl: 60_000 });

function invalidateProjectCache(publicId) {
  if (publicId) projectCache.delete(publicId);
}

module.exports = { projectCache, invalidateProjectCache };
