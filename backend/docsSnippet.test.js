/**
 * Regression test for Prompt C2 (improvement-prompts.md): the documented
 * embed snippet used to tell customers to load `/lipsync-sdk.js` with a
 * `data-public-id` attribute, but lipsync-sdk.js is the in-iframe Rive/
 * Gemini-Live engine and never read that attribute — a customer following
 * the docs got a silent no-op. The real, working mechanism is
 * public/js/embed-loader.js reading `data-bot` (see project.html's
 * generated Embed-tab snippet, the actual source of truth).
 *
 * This doesn't re-implement a DOM to execute embed-loader.js (no jsdom/
 * browser dependency in this project — see backend/routes/embed.test.js's
 * header for why route tests stub at the require boundary instead); it
 * directly asserts the static file contents stay reconciled, which is
 * cheap, deterministic, and catches the exact class of regression this
 * prompt was about: docs and code drifting apart again.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');

test('embed-loader.js actually reads the data-bot attribute the docs advertise', () => {
  const src = read('js/embed-loader.js');
  assert.match(src, /getAttribute\(['"]data-bot['"]\)/);
});

test('marketing snippets on index.html reference embed-loader.js + data-bot, not the dead lipsync-sdk.js + data-public-id combo', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /lipsync-sdk\.js["']\s*<\/span>\s*<br>\s*&nbsp;&nbsp;<span class="t-attr">data-public-id/);
  assert.doesNotMatch(html, /lipsync-sdk\.js["']\s*\n\s*<span class="s-att">data-public-id/);
  // Every <script ...> snippet block that ships a bot id uses embed-loader.js + data-bot.
  const scriptBlocks = html.match(/data-bot|data-public-id/g) || [];
  assert.ok(scriptBlocks.includes('data-bot'), 'expected at least one data-bot snippet on index.html');
  assert.ok(!scriptBlocks.includes('data-public-id'), 'index.html still advertises the non-functional data-public-id attribute');
});

test('docs/index.html "First embed" snippet uses embed-loader.js + data-bot', () => {
  const html = read('docs/index.html');
  assert.match(html, /src="https:\/\/your-deployment\.com\/js\/embed-loader\.js"/);
  assert.match(html, /data-bot="YOUR_BOT_ID"/);
  assert.doesNotMatch(html, /data-public-id/);
});

test('project.html\'s generated Embed-tab snippet (the real source of truth) still matches the documented mechanism', () => {
  const html = read('project.html');
  assert.match(html, /src="\$\{origin\}\/js\/embed-loader\.js"\s+data-bot="\$\{p\.publicId\}"\s+defer/);
});
