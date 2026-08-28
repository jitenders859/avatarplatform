const { test } = require('node:test');
const assert = require('node:assert/strict');

// `plans.js` does `const db = require('./db')` and calls `db.findOne(...)`.
// Node caches modules by resolved path, so requiring './db' here first and
// monkey-patching its `findOne` gives us the exact same singleton object
// `plans.js` holds a reference to — no new test-framework dependency, no
// live DATABASE_URL needed (pg's Pool doesn't connect eagerly on require).
const db = require('./db');

let findOneCalls;
let findOneImpl;
db.findOne = (...args) => {
  findOneCalls.push(args);
  return findOneImpl(...args);
};

const { PLANS, getPlan } = require('./plans');

test.beforeEach(() => {
  findOneCalls = [];
  findOneImpl = () => { throw new Error('db.findOne should not have been called for this case'); };
});

test('getPlan resolves a static plan id without querying the DB', async () => {
  const plan = await getPlan('pro');
  assert.equal(plan, PLANS.find(p => p.id === 'pro'));
  assert.equal(findOneCalls.length, 0);
});

test('getPlan short-circuits an undefined/falsy id to the free plan without querying the DB', async () => {
  const plan = await getPlan(undefined);
  assert.equal(plan, PLANS[0]);
  assert.equal(plan.id, 'free');
  assert.equal(findOneCalls.length, 0);
});

test('getPlan resolves an unknown id from plan_tiers, merging limits on top of the free defaults', async () => {
  findOneImpl = (table, where) => {
    assert.equal(table, 'plan_tiers');
    assert.deepEqual(where, { id: 'custom-acme' });
    // Deliberately partial limits — only overriding one key, like an admin
    // bumping a single number. Missing keys must fail closed (inherit the
    // free plan's conservative defaults), not resolve to `undefined`.
    return { id: 'custom-acme', name: 'Acme Custom', limits: { monthlyMessages: 50_000 } };
  };

  const plan = await getPlan('custom-acme');
  assert.equal(plan.id, 'custom-acme');
  assert.equal(plan.name, 'Acme Custom');
  assert.equal(plan.custom, true);
  assert.equal(plan.limits.monthlyMessages, 50_000);
  // Every other limit key falls back to the free plan's default instead of
  // being undefined (which would make every checkLimit comparison in
  // usage.js silently pass with `undefined > N` === false).
  assert.equal(plan.limits.projects, PLANS[0].limits.projects);
  assert.equal(plan.limits.maxFiles, PLANS[0].limits.maxFiles);
  assert.equal(plan.limits.storageMb, PLANS[0].limits.storageMb);
  assert.equal(plan.limits.monthlyEmbeddingChars, PLANS[0].limits.monthlyEmbeddingChars);
  assert.equal(plan.limits.urlSources, PLANS[0].limits.urlSources);
  assert.equal(findOneCalls.length, 1);
});

test('getPlan falls back to the free plan when the id resolves nowhere (static or plan_tiers)', async () => {
  findOneImpl = () => null;
  const plan = await getPlan('does-not-exist');
  assert.equal(plan, PLANS[0]);
  assert.equal(plan.id, 'free');
  assert.equal(findOneCalls.length, 1);
});
