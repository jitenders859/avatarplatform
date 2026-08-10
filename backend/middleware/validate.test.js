const { test } = require('node:test');
const assert = require('node:assert/strict');

// Pure Zod schemas — no DB access, no env vars, unlike auth.test.js.
const { schemas } = require('./validate');

test('tierUpsert rejects a whitespace-only name (regression: .trim() must run before .min())', () => {
  // Before the fix, the chain was `.min(1).trim()`, so "   " passed the
  // min-length check against the untrimmed string and was only trimmed to
  // "" afterward — letting an empty tier name through the schema.
  const result = schemas.tierUpsert.safeParse({
    name: '   ',
    limits: {
      projects: 1,
      filesPerProject: 1,
      storageMb: 1,
      monthlyMessages: 1,
      monthlyEmbeddingChars: 1,
      urlSources: 1,
    },
  });
  assert.equal(result.success, false);
});

test('tierUpsert accepts a valid payload and trims the name', () => {
  const result = schemas.tierUpsert.safeParse({
    name: '  Enterprise  ',
    limits: {
      projects: 10,
      filesPerProject: 50,
      storageMb: 1024,
      monthlyMessages: 5000,
      monthlyEmbeddingChars: 1000000,
      urlSources: 20,
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.data.name, 'Enterprise');
});

test('tierUpsert rejects a payload missing a limits key', () => {
  const result = schemas.tierUpsert.safeParse({
    name: 'Enterprise',
    limits: {
      projects: 10,
      filesPerProject: 50,
      storageMb: 1024,
      monthlyMessages: 5000,
      // monthlyEmbeddingChars missing
      urlSources: 20,
    },
  });
  assert.equal(result.success, false);
});

test('tierUpsert rejects a non-integer limit value', () => {
  const result = schemas.tierUpsert.safeParse({
    name: 'Enterprise',
    limits: {
      projects: 10.5,
      filesPerProject: 50,
      storageMb: 1024,
      monthlyMessages: 5000,
      monthlyEmbeddingChars: 1000000,
      urlSources: 20,
    },
  });
  assert.equal(result.success, false);
});

test('tierUpsert rejects a negative limit value', () => {
  const result = schemas.tierUpsert.safeParse({
    name: 'Enterprise',
    limits: {
      projects: 10,
      filesPerProject: 50,
      storageMb: 1024,
      monthlyMessages: 5000,
      monthlyEmbeddingChars: 1000000,
      urlSources: -1,
    },
  });
  assert.equal(result.success, false);
});

test('tierUpsert rejects an unknown extra key inside limits (regression: .strict() must catch it)', () => {
  // Without .strict(), an unrecognized 7th key would be silently stripped
  // by Zod instead of failing loudly, and the intended limit would
  // silently fall back to the free plan's default via getPlan()'s merge.
  const result = schemas.tierUpsert.safeParse({
    name: 'Enterprise',
    limits: {
      projects: 10,
      filesPerProject: 50,
      storageMb: 1024,
      monthlyMessages: 5000,
      monthlyEmbeddingChars: 1000000,
      urlSources: 20,
      somethingUnexpected: 1,
    },
  });
  assert.equal(result.success, false);
});

test('adminLogin accepts a valid email and password', () => {
  const result = schemas.adminLogin.safeParse({
    email: 'admin@example.com',
    password: 'hunter2',
  });
  assert.equal(result.success, true);
});

test('adminLogin lowercases the email, same as the login schema', () => {
  // Note: the shared `email` schema chains `.email().toLowerCase().trim()`,
  // so format validation runs before trimming — a value with surrounding
  // whitespace would fail the `.email()` format check. This matches the
  // existing `login` schema's behavior exactly (not something this task
  // changes), so this test only exercises the case-folding.
  const result = schemas.adminLogin.safeParse({
    email: 'ADMIN@Example.com',
    password: 'hunter2',
  });
  assert.equal(result.success, true);
  assert.equal(result.data.email, 'admin@example.com');
});

test('adminLogin rejects an empty password', () => {
  const result = schemas.adminLogin.safeParse({
    email: 'admin@example.com',
    password: '',
  });
  assert.equal(result.success, false);
});
