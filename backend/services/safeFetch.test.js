/**
 * Tests for backend/services/safeFetch.js — the SSRF guard shared by the
 * webhook-test/delivery paths (routes/projects.js, routes/embed.js) and the
 * URL-source ingester (services/url.js).
 *
 * All cases here use IP literals or non-http(s) schemes so validation never
 * needs a live DNS lookup or network connection.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assertSafeUrl, isDisallowedIP } = require('./safeFetch');

test('isDisallowedIP blocks loopback, private, and link-local addresses', () => {
  assert.equal(isDisallowedIP('127.0.0.1'), true);
  assert.equal(isDisallowedIP('10.0.0.5'), true);
  assert.equal(isDisallowedIP('172.16.0.1'), true);
  assert.equal(isDisallowedIP('192.168.1.1'), true);
  assert.equal(isDisallowedIP('169.254.169.254'), true); // cloud metadata
  assert.equal(isDisallowedIP('::1'), true);
  assert.equal(isDisallowedIP('fe80::1'), true);
  assert.equal(isDisallowedIP('fd00::1'), true); // IPv6 ULA
});

test('isDisallowedIP unwraps IPv4-mapped IPv6 addresses before checking', () => {
  assert.equal(isDisallowedIP('::ffff:127.0.0.1'), true);
  assert.equal(isDisallowedIP('::ffff:169.254.169.254'), true);
  assert.equal(isDisallowedIP('::ffff:8.8.8.8'), false);
});

test('isDisallowedIP allows ordinary public addresses', () => {
  assert.equal(isDisallowedIP('8.8.8.8'), false);
  assert.equal(isDisallowedIP('1.1.1.1'), false);
});

test('isDisallowedIP treats unparsable input as unsafe', () => {
  assert.equal(isDisallowedIP('not-an-ip'), true);
});

test('assertSafeUrl rejects non-http(s) schemes', async () => {
  await assert.rejects(assertSafeUrl('file:///etc/passwd'), /Only http\(s\)/);
  await assert.rejects(assertSafeUrl('gopher://127.0.0.1/'), /Only http\(s\)/);
});

test('assertSafeUrl rejects malformed URLs', async () => {
  await assert.rejects(assertSafeUrl('not a url'), /Invalid URL/);
});

test('assertSafeUrl rejects IP-literal SSRF targets, including cloud metadata', async () => {
  await assert.rejects(assertSafeUrl('http://169.254.169.254/latest/meta-data/'), /disallowed address/);
  await assert.rejects(assertSafeUrl('http://127.0.0.1:8080/'), /disallowed address/);
  await assert.rejects(assertSafeUrl('http://10.0.0.5/'), /disallowed address/);
  await assert.rejects(assertSafeUrl('http://192.168.1.1/'), /disallowed address/);
  await assert.rejects(assertSafeUrl('http://[::1]/'), /disallowed address/);
  await assert.rejects(assertSafeUrl('http://[::ffff:127.0.0.1]/'), /disallowed address/);
});

test('assertSafeUrl rejects decimal/hex/octal-obfuscated loopback and metadata IPs', async () => {
  // The WHATWG URL parser normalizes these to their dotted-quad equivalents
  // (127.0.0.1) before we ever see a hostname string, so obfuscation doesn't
  // bypass the IP-literal check.
  await assert.rejects(assertSafeUrl('http://0x7f000001/'), /disallowed address/);
  await assert.rejects(assertSafeUrl('http://2130706433/'), /disallowed address/);
  await assert.rejects(assertSafeUrl('http://017700000001/'), /disallowed address/);
});

test('assertSafeUrl allows a public IP literal', async () => {
  const parsed = await assertSafeUrl('http://8.8.8.8/');
  assert.equal(parsed.hostname, '8.8.8.8');
});
