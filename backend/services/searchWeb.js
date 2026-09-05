/**
 * Serper.dev-backed web search — the search_web tool's backend. Serper is
 * a fixed, trusted host (not caller-supplied), so this uses plain
 * node-fetch rather than services/safeFetch.js (that wrapper's SSRF guard
 * is for owner/caller-supplied URLs like webhook actions or URL-source
 * ingestion — see services/tools.js#callProjectAction for that case).
 *
 * searchWebForProject() is the entry point both the /search-web route and
 * the /ask heuristic fallback (answerQuestion.js) call — it's the one
 * place quota is checked and tracked, so the two callers can't double up
 * or diverge.
 */
const fetch = require('node-fetch');
const settings = require('./settings');
const { webSearchCache } = require('../cache');
const { checkLimit, trackWebSearch } = require('./usage');
const logger = require('../logger').child({ module: 'search-web' });

async function searchWeb(query, { language = 'en' } = {}) {
  const q = String(query).trim().replace(/[\r\n]+/g, ' ').slice(0, 300);
  if (!q) return [];

  const cacheKey = `${language}:${q.toLowerCase()}`;
  const cached = webSearchCache.get(cacheKey);
  if (cached) return cached;

  const start = Date.now();
  const apiKey = await settings.getSetting('SERPER_API_KEY');
  if (!apiKey) {
    logger.warn('SERPER_API_KEY not configured — search_web will return no results');
    return [];
  }

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, hl: language, num: 5 }),
    timeout: 8000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Serper search failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  const results = (data.organic || []).slice(0, 5).map(r => ({
    title: r.title,
    url: r.link,
    snippet: (r.snippet || '').slice(0, 220),
    source: (() => { try { return new URL(r.link).hostname; } catch { return null; } })(),
  }));

  webSearchCache.set(cacheKey, results);
  logger.info({ query: q, resultCount: results.length, latencyMs: Date.now() - start }, 'web search');
  return results;
}

/** Quota-checked entry point shared by the /search-web route and the /ask fallback. */
async function searchWebForProject(project, query, { language } = {}) {
  const limitCheck = await checkLimit(project.userId, 'webSearch', 1);
  if (!limitCheck.ok) {
    const err = new Error(limitCheck.reason);
    err.status = 402;
    err.quotaExceeded = true;
    throw err;
  }
  const results = await searchWeb(query, { language });
  await trackWebSearch(project.userId).catch(() => {});
  return results;
}

module.exports = { searchWeb, searchWebForProject };
