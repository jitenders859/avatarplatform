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

// ── createProject ─────────────────────────────────────────────

test('createProject accepts a bare name (characterId/systemPrompt/voice all optional)', () => {
  const result = schemas.createProject.safeParse({ name: 'My Bot' });
  assert.equal(result.success, true);
});

test('createProject rejects an empty name', () => {
  const result = schemas.createProject.safeParse({ name: '' });
  assert.equal(result.success, false);
});

test('createProject rejects a voice outside the 30 Gemini Live voices', () => {
  const result = schemas.createProject.safeParse({ name: 'Bot', voice: 'NotAVoice' });
  assert.equal(result.success, false);
});

// ── patchProject ──────────────────────────────────────────────

test('patchProject accepts an empty object (no-op patch)', () => {
  // Unlike createProject, every field here is optional so a caller can PATCH
  // any subset — including none, which routes/projects.js's own logic
  // (not this schema) treats as a valid no-op.
  const result = schemas.patchProject.safeParse({});
  assert.equal(result.success, true);
});

test('patchProject rejects an invalid widgetPosition', () => {
  const result = schemas.patchProject.safeParse({ widgetPosition: 'top-center' });
  assert.equal(result.success, false);
});

test('patchProject rejects a themeColor that is not a 6-digit hex color', () => {
  const result = schemas.patchProject.safeParse({ themeColor: 'purple' });
  assert.equal(result.success, false);
});

test('patchProject accepts a valid 6-digit hex themeColor', () => {
  const result = schemas.patchProject.safeParse({ themeColor: '#7c6af5' });
  assert.equal(result.success, true);
});

test('patchProject rejects an out-of-range avatarOffsetX', () => {
  const result = schemas.patchProject.safeParse({ avatarOffsetX: 500 });
  assert.equal(result.success, false);
});

test('patchProject rejects a widgetOffsetY below its 0 floor (avatar offsets allow negative, widget offsets do not)', () => {
  const result = schemas.patchProject.safeParse({ widgetOffsetY: -10 });
  assert.equal(result.success, false);
});

test('patchProject allows webhookUrl to be explicitly cleared with null', () => {
  const result = schemas.patchProject.safeParse({ webhookUrl: null });
  assert.equal(result.success, true);
  assert.equal(result.data.webhookUrl, null);
});

test('patchProject rejects a malformed webhookUrl (format only — SSRF/IP checks happen separately via assertSafeUrl)', () => {
  const result = schemas.patchProject.safeParse({ webhookUrl: 'not a url' });
  assert.equal(result.success, false);
});

test('patchProject rejects a capabilityTier outside basic/medium/advanced', () => {
  const result = schemas.patchProject.safeParse({ capabilityTier: 'ultra' });
  assert.equal(result.success, false);
});

// ── filesInit ─────────────────────────────────────────────────

test('filesInit rejects an empty files array', () => {
  const result = schemas.filesInit.safeParse({ files: [] });
  assert.equal(result.success, false);
});

test('filesInit rejects more than 20 files', () => {
  const files = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.pdf`, size: 100 }));
  const result = schemas.filesInit.safeParse({ files });
  assert.equal(result.success, false);
});

test('filesInit rejects a file over the 100MB size cap', () => {
  const result = schemas.filesInit.safeParse({ files: [{ name: 'big.pdf', size: 200 * 1024 * 1024 }] });
  assert.equal(result.success, false);
});

test('filesInit accepts a well-formed file list', () => {
  const result = schemas.filesInit.safeParse({ files: [{ name: 'notes.pdf', size: 1024, mimeType: 'application/pdf' }] });
  assert.equal(result.success, true);
});

// ── sourcesUrl ────────────────────────────────────────────────

test('sourcesUrl rejects a request with neither url nor urls', () => {
  const result = schemas.sourcesUrl.safeParse({});
  assert.equal(result.success, false);
});

test('sourcesUrl rejects a whitespace-only single url', () => {
  const result = schemas.sourcesUrl.safeParse({ url: '   ' });
  assert.equal(result.success, false);
});

test('sourcesUrl accepts a single url', () => {
  const result = schemas.sourcesUrl.safeParse({ url: 'https://example.com/docs' });
  assert.equal(result.success, true);
});

test('sourcesUrl rejects more than 20 urls', () => {
  const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
  const result = schemas.sourcesUrl.safeParse({ urls });
  assert.equal(result.success, false);
});

// ── captureFieldCreate / captureFieldPatch / captureFieldReorder ─

test('captureFieldCreate rejects a key that does not match the slug pattern', () => {
  const result = schemas.captureFieldCreate.safeParse({ label: 'Email', key: 'Email-Address', type: 'email' });
  assert.equal(result.success, false);
});

test('captureFieldCreate rejects type=select with no options', () => {
  const result = schemas.captureFieldCreate.safeParse({ label: 'Plan', key: 'plan', type: 'select' });
  assert.equal(result.success, false);
});

test('captureFieldCreate accepts type=select with options', () => {
  const result = schemas.captureFieldCreate.safeParse({ label: 'Plan', key: 'plan', type: 'select', options: ['A', 'B'] });
  assert.equal(result.success, true);
});

test('captureFieldCreate rejects an unknown type', () => {
  const result = schemas.captureFieldCreate.safeParse({ label: 'Foo', key: 'foo', type: 'currency' });
  assert.equal(result.success, false);
});

test('captureFieldPatch accepts a partial update', () => {
  const result = schemas.captureFieldPatch.safeParse({ label: 'New Label' });
  assert.equal(result.success, true);
});

test('captureFieldReorder rejects a non-array ids field', () => {
  const result = schemas.captureFieldReorder.safeParse({ ids: 'not-an-array' });
  assert.equal(result.success, false);
});

test('captureFieldReorder accepts an array of ids', () => {
  const result = schemas.captureFieldReorder.safeParse({ ids: ['a', 'b', 'c'] });
  assert.equal(result.success, true);
});

// ── createCheckoutSession ─────────────────────────────────────

test('createCheckoutSession rejects a missing planId', () => {
  const result = schemas.createCheckoutSession.safeParse({});
  assert.equal(result.success, false);
});

test('createCheckoutSession accepts a planId string', () => {
  const result = schemas.createCheckoutSession.safeParse({ planId: 'pro' });
  assert.equal(result.success, true);
});

// ── adminPatchUser / adminDeleteUser ──────────────────────────

test('adminPatchUser rejects an empty patch (nothing to update)', () => {
  const result = schemas.adminPatchUser.safeParse({});
  assert.equal(result.success, false);
});

test('adminPatchUser accepts suspended alone', () => {
  const result = schemas.adminPatchUser.safeParse({ suspended: true });
  assert.equal(result.success, true);
});

test('adminPatchUser accepts adminPlanId: null (clearing a tier)', () => {
  const result = schemas.adminPatchUser.safeParse({ adminPlanId: null });
  assert.equal(result.success, true);
});

test('adminDeleteUser rejects an empty confirmEmail', () => {
  const result = schemas.adminDeleteUser.safeParse({ confirmEmail: '' });
  assert.equal(result.success, false);
});

// ── flashcardCreate ───────────────────────────────────────────

test('flashcardCreate rejects a missing back', () => {
  const result = schemas.flashcardCreate.safeParse({ front: 'Q' });
  assert.equal(result.success, false);
});

test('flashcardCreate accepts front/back with an optional topicTag', () => {
  const result = schemas.flashcardCreate.safeParse({ front: 'Q', back: 'A', topicTag: 'chapter-1' });
  assert.equal(result.success, true);
});

// ── quizQuestionCreate / quizQuestionPatch ────────────────────

test('quizQuestionCreate rejects correctIndex out of bounds for the given options', () => {
  const result = schemas.quizQuestionCreate.safeParse({
    question: 'Q', options: ['A', 'B'], correctIndex: 2,
  });
  assert.equal(result.success, false);
});

test('quizQuestionCreate rejects fewer than 2 options', () => {
  const result = schemas.quizQuestionCreate.safeParse({
    question: 'Q', options: ['A'], correctIndex: 0,
  });
  assert.equal(result.success, false);
});

test('quizQuestionCreate accepts a valid question', () => {
  const result = schemas.quizQuestionCreate.safeParse({
    question: 'Q', options: ['A', 'B', 'C'], correctIndex: 1,
  });
  assert.equal(result.success, true);
});

test('quizQuestionPatch accepts a partial update (question only)', () => {
  const result = schemas.quizQuestionPatch.safeParse({ question: 'Updated question' });
  assert.equal(result.success, true);
});

// ── quizSuggestDistractors ────────────────────────────────────

test('quizSuggestDistractors rejects a missing correctAnswer', () => {
  const result = schemas.quizSuggestDistractors.safeParse({ question: 'Q' });
  assert.equal(result.success, false);
});

// ── videoResourceCreate ───────────────────────────────────────

test('videoResourceCreate rejects a non-youtube url', () => {
  const result = schemas.videoResourceCreate.safeParse({
    title: 'T', youtubeUrl: 'https://vimeo.com/123', topicTags: ['a'],
  });
  assert.equal(result.success, false);
});

test('videoResourceCreate rejects an empty topicTags array', () => {
  const result = schemas.videoResourceCreate.safeParse({
    title: 'T', youtubeUrl: 'https://youtu.be/abc123', topicTags: [],
  });
  assert.equal(result.success, false);
});

test('videoResourceCreate accepts a valid youtube.com watch url', () => {
  const result = schemas.videoResourceCreate.safeParse({
    title: 'T', youtubeUrl: 'https://www.youtube.com/watch?v=abc123', topicTags: ['physics'],
  });
  assert.equal(result.success, true);
});

// ── embedLead / embedRetrieve ─────────────────────────────────

test('embedLead rejects a missing data object', () => {
  const result = schemas.embedLead.safeParse({ sessionId: 's1' });
  assert.equal(result.success, false);
});

test('embedLead accepts sessionId + an empty data object', () => {
  const result = schemas.embedLead.safeParse({ sessionId: 's1', data: {} });
  assert.equal(result.success, true);
});

test('embedRetrieve rejects an empty query', () => {
  const result = schemas.embedRetrieve.safeParse({ query: '' });
  assert.equal(result.success, false);
});

test('embedRetrieve rejects k above the 10 cap', () => {
  const result = schemas.embedRetrieve.safeParse({ query: 'hello', k: 50 });
  assert.equal(result.success, false);
});

test('embedRetrieve defaults are left to the route (k is optional here)', () => {
  const result = schemas.embedRetrieve.safeParse({ query: 'hello' });
  assert.equal(result.success, true);
  assert.equal(result.data.k, undefined);
});

test('characterTriggerCreate accepts a minimal trigger (defaults to type trigger)', () => {
  const result = schemas.characterTriggerCreate.safeParse({ name: 'laughing', riveInput: 'Laugh' });
  assert.equal(result.success, true);
  assert.equal(result.data.inputType, undefined);
});

test('characterTriggerCreate rejects a name with disallowed symbols', () => {
  const result = schemas.characterTriggerCreate.safeParse({ name: 'laughing!!', riveInput: 'Laugh' });
  assert.equal(result.success, false);
});

test('characterTriggerCreate rejects activeValue above 100', () => {
  const result = schemas.characterTriggerCreate.safeParse({
    name: 'smile', riveInput: 'Smile', inputType: 'number', activeValue: 150,
  });
  assert.equal(result.success, false);
});

test('characterTriggerCreate accepts a number trigger with keywords', () => {
  const result = schemas.characterTriggerCreate.safeParse({
    name: 'laughing', riveInput: 'Smile', inputType: 'number', activeValue: 90, holdMs: 1500, keywords: 'haha, lol',
  });
  assert.equal(result.success, true);
});

test('characterTriggerPatch rejects an empty patch (nothing to update)', () => {
  const result = schemas.characterTriggerPatch.safeParse({});
  assert.equal(result.success, false);
});

test('characterTriggerPatch accepts keywords alone', () => {
  const result = schemas.characterTriggerPatch.safeParse({ keywords: 'joke, funny' });
  assert.equal(result.success, true);
});
