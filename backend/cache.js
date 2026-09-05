const { LRUCache } = require('lru-cache');

// Shared project config cache — keyed by publicId, 1 min TTL.
// Lives outside embed.js so projects.js can invalidate without a circular import.
const projectCache = new LRUCache({ max: 500, ttl: 60_000 });

function invalidateProjectCache(publicId) {
  if (publicId) projectCache.delete(publicId);
}

// Web search results cache — keyed by "language:normalizedQuery" in
// services/searchWeb.js. Cuts provider cost on repeated questions within
// a session (or across sessions/tenants asking the same thing).
const webSearchCache = new LRUCache({ max: 1000, ttl: 10 * 60_000 });

module.exports = { projectCache, invalidateProjectCache, webSearchCache };
