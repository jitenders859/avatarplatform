# Lip-sync: drive Rive mouth inputs as transition speeds

**Files:** `public/lipsync-sdk.js`, `public/docs/natural-lipsync.html`, `backend/lipsyncSdk.test.js`
**Status:** Implemented

## Context

The production character's mouth inputs (`100`–`122`, values `0`–`100`) do not
mean "how far open". As observed by driving the character by hand in the Rive
editor:

- `0` — inactive, no pull toward that mouth pose.
- `1`–`100` — move the mouth **into** that pose; the value is the **transition
  speed**. `10` eases in slowly, `100` changes instantaneously.
- The in-between frames of a switch from one pose to another are produced by
  Rive's own transition, and its speed is what the value controls.

The SDK's `timed-ramp` mode was built on the other reading (value = openness):
it ramps the active input `1 → 100` across each viseme with `easeInCubic`, and
`_applyVisemeTargets` glides every input's value toward its target per frame.
On a speed-driven character that produces, for every single viseme: a crawl
(value ≈ 1–20 for most of the viseme, i.e. almost no movement) followed by a
snap (value shoots to 100 at `visemePeakRatio`). The per-frame glide then adds
a second lag on top — the incoming speed itself ramps up from 0, and the
outgoing pose keeps pulling while its value decays. Result: "okay, but not
perfect" — mouth motion is bunched at viseme ends and trails the audio.

## Change

New default `visemeSpeedMode: 'rive-transition'` (previous modes kept):

- **One speed value per viseme**, written for the viseme's whole duration:
  `value = 4800 / durationMs × visemeTransitionScale`, clamped to
  `[visemeTransitionMinValue = 8, visemeTransitionMaxValue = 100]`. A 60 ms
  consonant gets 80, a 120 ms vowel 40, a 300 ms word gap 16, long pauses 8.
  `visemeTransitionValue: <number>` overrides the curve with a fixed speed.
- **No SDK-side glide** in this mode (`alpha = 1` in `_applyVisemeTargets`):
  a speed must reach Rive as-is; gliding it only delays the mouth.
- **No overlap pre-start** of the next viseme: Rive animates the switch at the
  incoming viseme's speed; holding two speed inputs would have both poses pull
  against each other. At a switch the outgoing input goes to `0` and the
  incoming one to its speed in the same frame.
- **Unscheduled rest** (end of speech, silence hold) closes softly (auto speed
  for a ~260 ms move); `immediate` rest (connect/interrupt/stop) still snaps
  to `100`.
- **Amplitude fallback** (audio audible, no phoneme scheduled yet): loudness
  maps to jaw-open *speed*; quiet audio rests the mouth rather than
  half-opening it.
- **Write-on-change**: a Rive input is only set when its integer value
  changes. Re-setting a number input every frame is wasted WASM calls at best
  and, for a state machine keyed on that input, can restart the transition.
- Option parsing fixed so an explicit `0` (e.g. `visemeOverlapMs: 0`) is kept
  instead of falling back to the default.

`timed-ramp` and `instant` are unchanged in behaviour and remain selectable
for custom characters whose input value really is openness.

## Tuning (all constructor options)

| Option | Default | Turn it when |
|---|---|---|
| `visemeTransitionScale` | `1` | First knob. `>1` if the mouth trails the audio, `<1` if it looks too snappy. |
| `visemeTransitionMinValue` | `8` | Long vowels / pauses look sluggish → raise. |
| `visemeTransitionMaxValue` | `100` | Quick consonants look too abrupt → lower (e.g. `70`). |
| `visemeTransitionValue` | `'auto'` | Want one uniform ease for every phoneme → set a number (e.g. `30`). |

The `4800` gain is a calibration guess for the speed→time mapping inside the
Rive file (which the SDK cannot read); `visemeTransitionScale` exists so that
guess can be corrected without touching the SDK.

## Testing

- `backend/lipsyncSdk.test.js` loads the SDK under Node with a stub `window`
  and pins the auto-speed curve (anchor, monotonicity, clamps, scale, fixed
  override), that `rive-transition` writes a constant per-viseme value and
  pushes it to Rive unglided and only on change, that `timed-ramp` still
  ramps and glides, and the rest/immediate-rest behaviour.
- Visual check needs a live Gemini Live session: load a bot, trigger speech,
  confirm mouth poses land with the sounds and that word gaps close softly
  instead of snapping shut. Adjust `visemeTransitionScale` if the pose
  timing is consistently early or late.
