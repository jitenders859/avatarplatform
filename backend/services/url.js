/**
 * Fetch a URL and extract clean readable text for indexing.
 *
 * Strategy:
 *   1. Fetch with a real-browser-ish User-Agent and a 15s timeout.
 *   2. Reject anything not text/html (PDFs etc. should be uploaded).
 *   3. Strip script/style/nav/header/footer/aside.
 *   4. Prefer <main>, <article>, or [role=main]; fall back to <body>.
 *   5. Normalize whitespace; preserve paragraph breaks.
 *
 * Returns: { url, finalUrl, title, text, faviconUrl, fetchedAt }
 */
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (compatible; AvatarPlatformBot/1.0; +https://avatarplatform.app)';
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 5 * 1024 * 1024; // 5MB cap on a single page

async function fetchUrl(url) {
  // Validate + normalize
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Fetch timed out');
    throw new Error(`Fetch failed: ${e.message}`);
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
    throw new Error(`Unsupported content-type: ${ct || 'unknown'} (only HTML pages can be ingested as URL sources; upload other formats as files)`);
  }

  // Cap response size — read as buffer to enforce limit
  const buf = await res.buffer();
  if (buf.length > MAX_BYTES) {
    throw new Error(`Page too large (${(buf.length / 1024 / 1024).toFixed(1)}MB > 5MB)`);
  }
  const html = buf.toString('utf8');

  return parseHtml(html, res.url || parsed.toString(), parsed.toString());
}

function parseHtml(html, finalUrl, originalUrl) {
  const $ = cheerio.load(html);

  // Drop noise
  $('script, style, noscript, template, iframe, svg, link[rel="stylesheet"]').remove();
  $('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]').remove();
  $('[aria-hidden="true"]').remove();

  // Title
  let title = ($('meta[property="og:title"]').attr('content')
    || $('title').first().text()
    || '').trim();
  if (!title) title = new URL(finalUrl).hostname;

  // Pick the best content root
  let root = $('main').first();
  if (!root.length) root = $('article').first();
  if (!root.length) root = $('[role="main"]').first();
  if (!root.length) root = $('body');

  // Extract text, preserving paragraph breaks
  const blocks = [];
  root.find('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, th').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  });

  // Fallback to whole-root text if structured pull came up empty
  let text = blocks.join('\n\n').trim();
  if (!text) {
    text = root.text().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Favicon — prefer rel=icon, fallback to /favicon.ico
  let favicon = $('link[rel="icon"], link[rel="shortcut icon"]').first().attr('href');
  if (favicon) {
    try { favicon = new URL(favicon, finalUrl).toString(); } catch { favicon = null; }
  } else {
    try { favicon = new URL('/favicon.ico', finalUrl).toString(); } catch { favicon = null; }
  }

  return {
    url: originalUrl,
    finalUrl,
    title: title.slice(0, 300),
    text,
    faviconUrl: favicon,
    fetchedAt: Date.now(),
  };
}

module.exports = { fetchUrl };
