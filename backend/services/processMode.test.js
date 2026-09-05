const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveProcessMode, checkProcessModeConfigured } = require('./processMode');

// Assigning `undefined` onto process.env stringifies it to "undefined"
// rather than unsetting the key, so unset/restore both go through delete.
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('resolveProcessMode defaults to inline off Vercel', () => {
  withEnv({ VERCEL: undefined, PROCESS_MODE: undefined }, () => {
    assert.equal(resolveProcessMode(), 'inline');
  });
});

test('resolveProcessMode defaults to inngest on Vercel', () => {
  withEnv({ VERCEL: '1', PROCESS_MODE: undefined }, () => {
    assert.equal(resolveProcessMode(), 'inngest');
  });
});

test('PROCESS_MODE explicitly overrides the Vercel default in both directions', () => {
  withEnv({ VERCEL: '1', PROCESS_MODE: 'inline' }, () => {
    assert.equal(resolveProcessMode(), 'inline');
  });
  withEnv({ VERCEL: undefined, PROCESS_MODE: 'inngest' }, () => {
    assert.equal(resolveProcessMode(), 'inngest');
  });
});

test('an invalid PROCESS_MODE value is ignored, falling back to the auto-detected default', () => {
  withEnv({ VERCEL: undefined, PROCESS_MODE: 'bogus' }, () => {
    assert.equal(resolveProcessMode(), 'inline');
  });
});

test('checkProcessModeConfigured warns only for inngest mode with no Inngest keys set', () => {
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(msg) };

  withEnv({ VERCEL: undefined, PROCESS_MODE: 'inline', INNGEST_EVENT_KEY: undefined, INNGEST_SIGNING_KEY: undefined }, () => {
    checkProcessModeConfigured(logger);
  });
  assert.equal(warnings.length, 0, 'inline mode never needs Inngest keys');

  withEnv({ VERCEL: '1', PROCESS_MODE: undefined, INNGEST_EVENT_KEY: undefined, INNGEST_SIGNING_KEY: undefined }, () => {
    checkProcessModeConfigured(logger);
  });
  assert.equal(warnings.length, 1, 'inngest mode with no keys should warn once');

  withEnv({ VERCEL: '1', PROCESS_MODE: undefined, INNGEST_EVENT_KEY: 'key', INNGEST_SIGNING_KEY: undefined }, () => {
    checkProcessModeConfigured(logger);
  });
  assert.equal(warnings.length, 1, 'having at least the event key is enough to suppress the warning');
});
