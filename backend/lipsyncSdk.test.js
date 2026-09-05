/**
 * Unit tests for the mouth-driving math in public/lipsync-sdk.js.
 *
 * The SDK is a browser UMD bundle, so it's loaded here with a bare-bones
 * `window`/`document` stub and exercised through `LipsyncAvatar.prototype`
 * on hand-built instances (the real constructor builds DOM and needs
 * rive.js + Gemini Live, neither of which exists in Node).
 *
 * What's pinned down: in the default 'rive-transition' mode a Rive input's
 * value is the character's TRANSITION SPEED into a mouth pose (10 = slow,
 * 100 = instant), so the SDK must write one duration-derived speed per
 * viseme and push it to Rive unglided — not ramp it 1→100 like the legacy
 * 'timed-ramp' mode does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

global.window = globalThis;
global.document = { readyState: 'complete' };
const LipsyncAvatar = require(path.join(__dirname, '..', 'public', 'lipsync-sdk.js'));

const RIVE_MODE_OPTS = {
  visemeSpeedMode: 'rive-transition',
  visemeTransitionValue: 'auto',
  visemeTransitionMinValue: 8,
  visemeTransitionMaxValue: 100,
  visemeTransitionScale: 1,
  visemeMinValue: 1,
  visemeMaxValue: 100,
  visemePeakRatio: 0.88,
  visemeSmoothingMs: 45,
};

/** A LipsyncAvatar with just enough state for the viseme methods to run. */
function makeAvatar(optOverrides = {}) {
  const a = Object.create(LipsyncAvatar.prototype);
  a._opts = { ...RIVE_MODE_OPTS, ...optOverrides };
  a._riveReady = true;
  a._riveInputByAz = [100,101,102,110,103,113,105,104,108,112,120,111,119,114,115,106,116,117,109,118,121,107,122];
  a._riveInputs = {};
  a._writes = []; // [inputName, value] in the order pushed to Rive
  for (let n = 100; n <= 122; n++) {
    const name = String(n);
    a._riveInputs[name] = { _v: 0, get value() { return this._v; }, set value(v) { this._v = v; a._writes.push([name, v]); } };
  }
  a._wTarget = new Float32Array(23).fill(0);
  a._wCurrent = new Float32Array(23).fill(0);
  a._riveWritten = Object.create(null);
  a._currentAzId = 0;
  a._el = { visemePill: { style: {} } };
  a._fire = () => {};
  return a;
}

test('rive-transition auto speed: shorter visemes get a higher (faster) value, long ones a lower one', () => {
  const a = makeAvatar();
  const v = ms => a._riveTransitionValue(ms);
  assert.equal(v(120), 40, 'a typical 120ms viseme is the 40 anchor');
  assert.equal(v(60), 80);
  assert.equal(v(300), 16);
  assert.ok(v(30) === 100, 'very short consonants snap (100)');
  assert.equal(v(1000), 8, 'long pauses floor at visemeTransitionMinValue');
  const series = [30, 50, 80, 120, 200, 400, 1000].map(v);
  for (let i = 1; i < series.length; i++) assert.ok(series[i] <= series[i - 1], `monotonic: ${series}`);
});

test('rive-transition auto speed honours scale and min/max clamps', () => {
  assert.equal(makeAvatar({ visemeTransitionScale: 2 })._riveTransitionValue(120), 80);
  assert.equal(makeAvatar({ visemeTransitionScale: 0.5 })._riveTransitionValue(120), 20);
  assert.equal(makeAvatar({ visemeTransitionMaxValue: 70 })._riveTransitionValue(30), 70);
  assert.equal(makeAvatar({ visemeTransitionMinValue: 20 })._riveTransitionValue(1000), 20);
});

test('visemeTransitionValue as a number writes that fixed speed for every viseme', () => {
  const a = makeAvatar({ visemeTransitionValue: 30 });
  assert.equal(a._riveTransitionValue(30), 30);
  assert.equal(a._riveTransitionValue(500), 30);
  assert.equal(a._timedMouthValue(0.5, 500), 30);
});

test('rive-transition: _timedMouthValue is constant across the viseme (no 1→100 ramp)', () => {
  const a = makeAvatar();
  const values = [0, 0.25, 0.5, 0.88, 1].map(p => a._timedMouthValue(p, 120));
  assert.deepEqual(values, [40, 40, 40, 40, 40]);
});

test('timed-ramp (legacy) still ramps the value from the floor to 100 across the viseme', () => {
  const a = makeAvatar({ visemeSpeedMode: 'timed-ramp' });
  assert.equal(a._timedMouthValue(0, 120), 1);
  assert.equal(a._timedMouthValue(1, 120), 100);
  const mid = a._timedMouthValue(0.5, 120);
  assert.ok(mid > 1 && mid < 100, `mid-ramp value ${mid} should be between the floor and 100`);
});

test('rive-transition: the speed is pushed to Rive unglided, in the same frame it is set', () => {
  const a = makeAvatar();
  a._setVisemeWeights({ 3: 40 }); // az 3 (o) -> input 110
  a._applyVisemeTargets(16);       // one ~60fps frame
  assert.equal(a._riveInputs['110'].value, 40, 'input 110 gets the full speed immediately');
  a._setVisemeWeights({ 22: 80 }); // switch to az 22 (ng) -> input 122
  a._applyVisemeTargets(16);
  assert.equal(a._riveInputs['110'].value, 0, 'outgoing input is released at once, not decayed');
  assert.equal(a._riveInputs['122'].value, 80);
});

test('timed-ramp: the value still glides toward its target over several frames', () => {
  const a = makeAvatar({ visemeSpeedMode: 'timed-ramp', visemeSmoothingMs: 45 });
  a._setVisemeWeights({ 3: 100 });
  a._applyVisemeTargets(16);
  const first = a._riveInputs['110'].value;
  assert.ok(first > 0 && first < 100, `after one frame the value (${first}) is partway`);
  for (let i = 0; i < 30; i++) a._applyVisemeTargets(16);
  assert.equal(a._riveInputs['110'].value, 100);
});

test('a Rive input is only written when its integer value changes', () => {
  const a = makeAvatar();
  a._setVisemeWeights({ 3: 40 });
  a._applyVisemeTargets(16);
  const after = a._writes.length;
  for (let i = 0; i < 10; i++) { a._setVisemeWeights({ 3: 40 }); a._applyVisemeTargets(16); }
  assert.equal(a._writes.length, after, 'holding the same viseme/speed produces no further Rive writes');
});

test('rive-transition: an unscheduled rest closes softly, an immediate rest snaps', () => {
  const a = makeAvatar();
  a._setAzureViseme(0);
  assert.equal(a._wTarget[0], a._riveTransitionValue(260), 'rest = soft close (auto speed for ~260ms)');
  a._setAzureViseme(0, { immediate: true });
  assert.equal(a._riveInputs['100'].value, 100, 'immediate rest is written straight to Rive at 100');
});
