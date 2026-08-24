/**
 * SSRF-safe fetch wrapper for server-side requests to caller-supplied URLs
 * (webhooks, URL source ingestion). Used anywhere the target host is not
 * a fixed, trusted value.
 *
 * Defenses:
 *   1. Scheme allowlist: http/https only.
 *   2. Resolve the hostname ourselves and reject loopback/private/link-local/
 *      reserved addresses (covers cloud metadata endpoints like 169.254.169.254).
 *   3. Pin the connection to the resolved+validated IP (via a custom DNS
 *      lookup on the request agent) so a second DNS resolution done by the
 *      HTTP client can't be rebound to a different, disallowed address.
 *   4. Follow redirects manually, re-validating every hop, capped at 3.
 */
const fetch = require('node-fetch');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const ipaddr = require('ipaddr.js');

const MAX_REDIRECTS = 3;

// Ranges ipaddr.js's range() reports as unsafe for outbound server-side requests.
const DISALLOWED_RANGES = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'carrierGradeNat',
  'private',
  'reserved',
  'uniqueLocal',
  'benchmarking',
  'amt',
  'as112',
  'as112v6',
  'orchid2',
  'droneRemoteIdProtocolEntityTags',
]);

function isDisallowedIP(ip) {
  let addr;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true; // unparsable -> treat as unsafe
  }
  if (addr.kind() === 'ipv6') {
    const a = addr;
    if (a.isIPv4MappedAddress && a.isIPv4MappedAddress()) {
      return isDisallowedIP(a.toIPv4Address().toString());
    }
  }
  return DISALLOWED_RANGES.has(addr.range());
}

/**
 * Resolve a hostname and return the validated list of IPs, or throw.
 */
async function resolveAndValidate(rawHostname) {
  // URL.hostname keeps brackets around IPv6 literals (e.g. "[::1]") - strip
  // them so both ipaddr.js and dns.lookup see a bare address.
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  let addresses;
  if (ipaddr.isValid(hostname)) {
    addresses = [hostname];
  } else {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = records.map(r => r.address);
  }
  if (!addresses.length) throw new Error('Could not resolve host');

  const safe = addresses.filter(ip => !isDisallowedIP(ip));
  if (!safe.length) {
    throw new Error(`Refusing to connect to disallowed address for host "${hostname}"`);
  }
  return safe;
}

function pinnedAgent(protocol, pinnedIP) {
  const Agent = protocol === 'https:' ? https.Agent : http.Agent;
  return new Agent({
    lookup: (hostname, options, callback) => {
      if (options.all) return callback(null, [{ address: pinnedIP, family: ipaddr.parse(pinnedIP).kind() === 'ipv6' ? 6 : 4 }]);
      callback(null, pinnedIP, ipaddr.parse(pinnedIP).kind() === 'ipv6' ? 6 : 4);
    },
  });
}

/**
 * Validate that a URL is well-formed, uses http(s), and does not resolve to
 * a disallowed address. Throws with a user-facing message on failure.
 * Intended for validating input (e.g. at PATCH time) before it's persisted.
 */
async function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('Only http(s) URLs are supported');
  }
  await resolveAndValidate(parsed.hostname);
  return parsed;
}

/**
 * SSRF-safe fetch. Same rough shape as node-fetch, minus support for
 * `redirect: 'follow'` (redirects are always validated per-hop here).
 */
async function safeFetch(rawUrl, options = {}) {
  let currentUrl = rawUrl;
  let { method = 'GET', body, headers } = options;
  let redirects = 0;

  for (;;) {
    const parsed = await assertSafeUrl(currentUrl);
    const [pinnedIP] = await resolveAndValidate(parsed.hostname);
    const agent = pinnedAgent(parsed.protocol, pinnedIP);

    const res = await fetch(parsed.toString(), {
      ...options,
      method,
      body,
      headers,
      agent,
      redirect: 'manual',
    });

    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) throw new Error('Too many redirects');
      currentUrl = new URL(res.headers.get('location'), parsed.toString()).toString();
      // Fetch-spec redirect semantics: 303 always drops to GET/no body;
      // 301/302 drop POST to GET/no body but leave other methods as-is.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }

    return res;
  }
}

module.exports = { safeFetch, assertSafeUrl, isDisallowedIP };
