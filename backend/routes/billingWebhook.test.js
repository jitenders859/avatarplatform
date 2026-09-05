/**
 * POST /api/billing/webhook must reject payloads with a missing/invalid
 * Stripe signature (400), refuse to process anything when
 * STRIPE_WEBHOOK_SECRET isn't configured (500, fail closed rather than
 * trusting an unverified payload), and accept + process a genuinely valid
 * signature (improvement-prompts.md Prompt T1 item 5).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-do-not-use-in-prod';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

stubFile('../db', {
  findOne: async () => null,
  findAll: async () => [],
  query: async () => [],
  queryOne: async () => null,
  insert: async () => null,
  update: async () => null,
});

const VALID_SIG = 'valid-test-signature';

function stubStripeService() {
  stubFile('../services/stripe', {
    getStripe: () => ({
      webhooks: {
        constructEvent: (body, sig, secret) => {
          if (sig !== VALID_SIG || !secret) {
            const err = new Error('No signatures found matching the expected signature for payload');
            throw err;
          }
          return JSON.parse(body.toString());
        },
      },
    }),
    isConfigured: () => true,
  });
}

function post(port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function buildApp() {
  delete require.cache[require.resolve('./billing')];
  const { webhookHandler } = require('./billing');
  const app = express();
  // Matches server.js's real mount exactly: raw body BEFORE the JSON parser.
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), webhookHandler);
  return app;
}

test('webhook rejects a payload with no signature header', async (t) => {
  stubStripeService();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const app = await buildApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const res = await post(server.address().port, '/api/billing/webhook', JSON.stringify({ type: 'checkout.session.completed' }));
  assert.equal(res.status, 400);
});

test('webhook rejects a payload with an invalid signature', async (t) => {
  stubStripeService();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const app = await buildApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const res = await post(server.address().port, '/api/billing/webhook', JSON.stringify({ type: 'checkout.session.completed' }), {
    'stripe-signature': 'forged-signature-not-matching',
  });
  assert.equal(res.status, 400);
  assert.match(res.body, /Webhook Error/);
});

test('webhook fails closed (500) when STRIPE_WEBHOOK_SECRET is unset, even with a well-formed request', async (t) => {
  stubStripeService();
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const app = await buildApp();
  const server = app.listen(0);
  t.after(() => server.close());
  const res = await post(server.address().port, '/api/billing/webhook', JSON.stringify({ type: 'checkout.session.completed' }), {
    'stripe-signature': VALID_SIG,
  });
  assert.equal(res.status, 500);
});

test('webhook accepts and processes a genuinely valid signature', async (t) => {
  stubStripeService();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const app = await buildApp();
  const server = app.listen(0);
  t.after(() => server.close());
  // event.type isn't one of the switch cases billing.js handles, so this
  // exercises "valid signature, no-op event type" -> 200 without needing
  // to stub the subscription-sync DB calls.
  const res = await post(server.address().port, '/api/billing/webhook', JSON.stringify({ type: 'some.unhandled.event' }), {
    'stripe-signature': VALID_SIG,
  });
  assert.equal(res.status, 200);
});
