/**
 * HybridLipSyncController — orchestrates three lip-sync modes for Rive characters.
 *
 * Designed for Gemini Live speech-to-speech, which provides PCM audio chunks
 * and text transcription deltas but NOT phoneme timestamps.
 *
 * Mode 1 — text-estimated: transcript delta available → VisemeMap builds a
 *   phoneme timeline → played back against the AudioClock master timeline.
 *   Typical accuracy: ±60–120ms vs. actual phoneme start.
 *
 * Mode 2 — amplitude: audio playing but no visemes queued (first packet, network
 *   gap, or non-transcribed audio) → drives jaw from FFT energy via AmplitudeFallback.
 *
 * Mode 3 — neutral: audio buffer exhausted → mouth closes.
 *
 * Load order (must all be loaded before this file):
 *   <script src="/js/audio-clock.js"></script>
 *   <script src="/js/viseme-map.js"></script>
 *   <script src="/js/amplitude-fallback.js"></script>
 *   <script src="/js/hybrid-lipsync-controller.js"></script>
 *
 * Usage:
 *   const ctrl = new HybridLipSyncController({
 *     riveInputs: { '100': closedInput, '101': openInput, ... },
 *     sampleRate: 24000,
 *     anticipationMs: 40,
 *     debug: true,
 *   });
 *   ctrl.start();
 *
 *   // When Gemini sends a PCM audio chunk (base64 → Int16 → Float32):
 *   const float32 = decodeToFloat32(base64Chunk);
 *   ctrl.feedAudio(float32);
 *
 *   // When Gemini sends a transcript delta:
 *   ctrl.feedTranscript('Hello, how are you?');
 *
 *   // After turn ends:
 *   ctrl.reset();
 *
 * How to tune:
 *   mouthDelayMs: positive if audio arrives late (mouth leads audio),
 *                 negative if transcript arrives late (mouth lags audio).
 *   anticipationMs: mouth starts moving before the phoneme. 30–50ms is natural.
 *   minVisemeMs: minimum hold per viseme. Prevents mechanical flutter on fast
 *                consonants. 40–60ms is safe.
 *   amplitudeSensitivity: gain for amplitude fallback. 1.0 is neutral;
 *                         2.0 gives more exaggerated jaw movement.
 */

(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else global.HybridLipSyncController = factory();
}(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v || 0)); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function easeOut2(t) { t = clamp01(t); return 1 - (1-t)*(1-t); }
  function easeInOut3(t) {
    t = clamp01(t);
    return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
  }

  // ── Frequency band helpers ────────────────────────────────
  function bandAvg(buf, lo, hi, binHz) {
    let sum = 0, n = 0;
    const s = Math.max(0, Math.floor(lo / binHz));
    const e = Math.min(buf.length, Math.ceil(hi / binHz));
    for (let i = s; i < e; i++) { sum += buf[i]; n++; }
    return n ? sum / n / 255 : 0;
  }

  // ── Emotion keywords ─────────────────────────────────────
  const POSITIVE_RE = /\b(great|excellent|wonderful|amazing|love|thanks|glad|happy|fantastic|awesome|perfect|sure|absolutely|certainly|brilliant|delightful|enjoy)\b/i;
  const NEGATIVE_RE = /\b(sorry|unfortunately|problem|issue|error|fail|mistake|wrong|bad|trouble|apologize|regret)\b/i;
  const SURPRISE_RE = /\b(wow|incredible|really|oh my|unbelievable|fascinating|interesting|remarkable)\b/i;

  // ══════════════════════════════════════════════════════════
  //  CharacterBehaviorController
  //  Expression/idle animation layer that runs alongside lip-sync.
  //  Drives blink, eye dart, head movement, breathing, and emotion
  //  reactions through Rive state machine inputs.
  //
  //  How to add an expression:
  //    1. Add a mapping key in opts.inputMap or the default _map.
  //    2. Call _setNumber(key, value) or _fireTrigger(key).
  //    3. Wrap in _canGesture() guard + _markGesture(cooldownMs).
  // ══════════════════════════════════════════════════════════
  class CharacterBehaviorController {
    /**
     * @param {object} inputs         - Flat map of inputName → RiveStateMachineInput
     * @param {object} [opts]
     * @param {object} [opts.inputMap]          - Override default input name mappings
     * @param {string} [opts.blinkInput]        - Rive input name for blink (default: 'Blink')
     * @param {string} [opts.eyeXInput]         - Eye horizontal drift
     * @param {string} [opts.eyeYInput]         - Eye vertical drift
     * @param {string} [opts.headTiltInput]     - Head tilt (positive = right)
     * @param {string} [opts.headNodInput]      - Head nod (positive = down)
     * @param {string} [opts.breatheInput]      - Breathing amount
     * @param {string} [opts.smileInput]        - Smile amount (0-100)
     * @param {string} [opts.browsInput]        - Brow raise (0-100)
     * @param {number} [opts.idleIntensity=1.0] - Scale all idle motions
     * @param {number} [opts.gestureIntensity=1.0]
     * @param {boolean}[opts.debug=false]
     */
    constructor(inputs, opts = {}) {
      this._inputs = inputs || {};

      this._map = {
        blink:    'Blink',
        eyeX:     'EyeX',
        eyeY:     'EyeY',
        headTilt: 'HeadTilt',
        headNod:  'HeadNod',
        breathe:  'Breathe',
        smile:    'Smile',
        brows:    'BrowRaise',
        ...opts.inputMap,
      };
      if (opts.blinkInput)    this._map.blink    = opts.blinkInput;
      if (opts.eyeXInput)     this._map.eyeX     = opts.eyeXInput;
      if (opts.eyeYInput)     this._map.eyeY     = opts.eyeYInput;
      if (opts.headTiltInput) this._map.headTilt = opts.headTiltInput;
      if (opts.headNodInput)  this._map.headNod  = opts.headNodInput;
      if (opts.breatheInput)  this._map.breathe  = opts.breatheInput;
      if (opts.smileInput)    this._map.smile    = opts.smileInput;
      if (opts.browsInput)    this._map.brows    = opts.browsInput;

      this._idleIntensity    = opts.idleIntensity    ?? 1.0;
      this._gestureIntensity = opts.gestureIntensity ?? 1.0;
      this._debug            = !!opts.debug;

      this._state   = 'idle';
      this._running = false;
      this._raf     = null;
      this._lastMs  = 0;

      // Continuous motion state
      this._breathPhase    = 0;
      this._idleNoisePhase = 0;

      // Timed events
      this._nextBlinkMs = 0;
      this._nextDartMs  = 0;
      this._dartTargetX = 0;
      this._dartTargetY = 0;
      this._dartReturnMs = 0;

      // Gesture cooldown
      this._gestureCooldownMs = 0;
    }

    start() {
      if (this._running) return;
      this._running = true;
      this._lastMs  = performance.now();
      this._nextBlinkMs = performance.now() + this._blinkInterval();
      this._nextDartMs  = performance.now() + 3000 + Math.random() * 4000;
      this._tick();
    }

    stop() {
      this._running = false;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    }

    /** Set character state: 'idle' | 'listening' | 'speaking' | 'thinking' */
    setState(state) {
      if (state === this._state) return;
      this._state = state;
      if (this._debug) console.log('[CharBehavior] state →', state);
    }

    /**
     * React to transcript text with emotional expressions.
     * Call this when a transcript delta arrives.
     */
    reactToEmotion(text) {
      if (!text) return;
      if (SURPRISE_RE.test(text)) { this._triggerBrows(); return; }
      if (POSITIVE_RE.test(text)) { this._triggerSmile(); return; }
      if (NEGATIVE_RE.test(text)) { this._triggerEmpathy(); }
      if (/\?/.test(text))         { this._triggerThinkingLook(); }
    }

    _tick() {
      if (!this._running) return;
      const now = performance.now();
      const dt  = Math.min(now - this._lastMs, 100); // cap dt to avoid jumps after tab sleep
      this._lastMs = now;

      this._updateBreathe(dt);
      this._updateBlink(now);
      this._updateEyeDart(now);
      this._updateIdleHead(dt);

      if (this._state === 'listening') this._applyListeningPose(now);
      if (this._state === 'thinking')  this._applyThinkingPose(now);

      this._raf = requestAnimationFrame(() => this._tick());
    }

    // ── Breathing ────────────────────────────────────────────
    _updateBreathe(dt) {
      if (this._state !== 'idle' && this._state !== 'listening') return;
      this._breathPhase += dt * 0.0028; // ~2.8s breath cycle
      const v = (Math.sin(this._breathPhase) * 0.5 + 0.5) * 30 * this._idleIntensity;
      this._setNumber('breathe', v);
    }

    // ── Blink ─────────────────────────────────────────────────
    _updateBlink(now) {
      if (now < this._nextBlinkMs) return;
      this._performBlink();
      this._nextBlinkMs = now + this._blinkInterval();
    }

    _performBlink() {
      this._fireTrigger('blink');
      // Micro-blink variant (quick double blink occasionally)
      if (Math.random() < 0.12) {
        setTimeout(() => this._fireTrigger('blink'), 180);
      }
    }

    _blinkInterval() {
      const base = this._state === 'idle' ? 3000 : 4500;
      return base + Math.random() * 3000;
    }

    // ── Eye darts ─────────────────────────────────────────────
    _updateEyeDart(now) {
      if (this._state === 'thinking') return; // thinking pose handles eyes
      if (now < this._nextDartMs) return;

      // Move eyes to random target
      this._dartTargetX = (Math.random() - 0.5) * 22;
      this._dartTargetY = (Math.random() - 0.5) * 12;
      this._dartReturnMs = now + 350 + Math.random() * 300;
      this._setNumber('eyeX', this._dartTargetX * this._idleIntensity);
      this._setNumber('eyeY', this._dartTargetY * this._idleIntensity);

      // Schedule return to center
      const retMs = this._dartReturnMs - now;
      setTimeout(() => {
        this._setNumber('eyeX', 0);
        this._setNumber('eyeY', 0);
      }, retMs);

      this._nextDartMs = now + 3000 + Math.random() * 5000;
    }

    // ── Idle head movement ────────────────────────────────────
    _updateIdleHead(dt) {
      if (this._state !== 'idle') return;
      this._idleNoisePhase += dt * 0.0009;
      const tilt = Math.sin(this._idleNoisePhase * 0.7) * 5  * this._idleIntensity;
      const nod  = Math.sin(this._idleNoisePhase * 0.5) * 3  * this._idleIntensity;
      this._setNumber('headTilt', tilt);
      this._setNumber('headNod', nod);
    }

    // ── State-specific poses ──────────────────────────────────
    _applyListeningPose(now) {
      // Slight lean-in: head tilts slightly toward speaker
      const wave = Math.sin(now * 0.0006) * 2 + 4;
      this._setNumber('headTilt', wave * this._idleIntensity);
    }

    _applyThinkingPose(now) {
      // Eyes look up-right (universal thinking direction)
      const drift = Math.sin(now * 0.0009) * 4;
      this._setNumber('eyeX', 14 + drift);
      this._setNumber('eyeY', -16 + drift * 0.5);
    }

    // ── Gesture triggers ──────────────────────────────────────
    _triggerSmile() {
      if (!this._canGesture()) return;
      const v = 80 * this._gestureIntensity;
      this._setNumber('smile', v);
      setTimeout(() => this._setNumber('smile', 0), 1400);
      this._markGesture(2000);
    }

    _triggerBrows() {
      if (!this._canGesture()) return;
      const v = 65 * this._gestureIntensity;
      this._setNumber('brows', v);
      setTimeout(() => this._setNumber('brows', 0), 550);
      this._markGesture(900);
    }

    _triggerEmpathy() {
      if (!this._canGesture()) return;
      this._setNumber('headTilt', 10 * this._gestureIntensity);
      setTimeout(() => this._setNumber('headTilt', 0), 1200);
      this._markGesture(2500);
    }

    _triggerThinkingLook() {
      if (!this._canGesture()) return;
      this._setNumber('eyeX', 18 * this._gestureIntensity);
      this._setNumber('eyeY', -13 * this._gestureIntensity);
      setTimeout(() => { this._setNumber('eyeX', 0); this._setNumber('eyeY', 0); }, 700);
      this._markGesture(1200);
    }

    // ── Cooldown ──────────────────────────────────────────────
    _canGesture()             { return performance.now() >= this._gestureCooldownMs; }
    _markGesture(cooldownMs)  { this._gestureCooldownMs = performance.now() + cooldownMs; }

    // ── Rive input drivers ────────────────────────────────────
    _setNumber(key, value) {
      const name = this._map[key];
      if (!name) return;
      const inp = this._inputs[name];
      if (!inp) return;
      // Duck-type: skip trigger inputs (they have .fire() but no settable .value)
      if (typeof inp.fire === 'function' && typeof inp.value === 'undefined') return;
      inp.value = clamp(value, -100, 100);
    }

    _fireTrigger(key) {
      const name = this._map[key];
      if (!name) return;
      const inp = this._inputs[name];
      if (!inp) return;
      if (typeof inp.fire === 'function') inp.fire();
      else if ('value' in inp) inp.value = true;
    }
  }

  // ══════════════════════════════════════════════════════════
  //  HybridLipSyncController
  // ══════════════════════════════════════════════════════════
  class HybridLipSyncController {
    /**
     * @param {object} opts
     * @param {object} opts.riveInputs        - Map of inputName → RiveStateMachineInput,
     *                                          OR array of RiveStateMachineInput objects.
     * @param {number} [opts.sampleRate=24000]
     * @param {number} [opts.anticipationMs=40]   - Pre-roll mouth before phoneme (ms)
     * @param {number} [opts.minVisemeMs=45]       - Minimum viseme hold (ms)
     * @param {number} [opts.smoothingMs=70]       - Value LERP window (ms, higher = smoother)
     * @param {number} [opts.mouthDelayMs=0]       - Latency compensation. Positive = delay
     *                                              mouth (audio arrives late). Negative = advance.
     * @param {number} [opts.amplitudeSensitivity=1.0]
     * @param {string} [opts.neutralInput='100']   - Rive input name for closed mouth
     * @param {string} [opts.talkInput='101']      - Rive input name for jaw-open
     * @param {string} [opts.altInput='105']       - Secondary fallback shape input name
     * @param {string} [opts.language]             - Force language for G2P ('english', etc.)
     * @param {object} [opts.behaviorConfig]       - Options forwarded to CharacterBehaviorController
     * @param {boolean}[opts.enableBehavior=false] - Enable CharacterBehaviorController
     * @param {boolean}[opts.debug=false]
     *
     * Public callbacks (assign after construction):
     *   ctrl.onModeChange = (mode) => {}   // 'text' | 'amplitude' | 'neutral'
     *   ctrl.onViseme     = (input, val) => {}
     */
    constructor(opts = {}) {
      // Normalise riveInputs to a plain object keyed by name
      const rawInputs = opts.riveInputs || {};
      if (Array.isArray(rawInputs)) {
        this._inputs = {};
        for (const inp of rawInputs) {
          if (inp && inp.name) this._inputs[inp.name] = inp;
        }
      } else {
        this._inputs = rawInputs;
      }

      // Config
      this._sampleRate          = opts.sampleRate          || 24000;
      this._anticipationMs      = opts.anticipationMs      ?? 40;
      this._minVisemeMs         = opts.minVisemeMs         ?? 45;
      this._smoothingMs         = opts.smoothingMs         ?? 70;
      this._mouthDelayMs        = opts.mouthDelayMs        ?? 0;
      this._amplitudeSensitivity = opts.amplitudeSensitivity ?? 1.0;
      this._neutralInput        = String(opts.neutralInput ?? 100);
      this._talkInput           = String(opts.talkInput    ?? 101);
      this._altInput            = String(opts.altInput     ?? 105);
      this._debug               = !!opts.debug;

      // Dependency injection helpers: use globals if available
      const ClockClass    = (typeof AudioClock    !== 'undefined') ? AudioClock    : null;
      const MapClass      = (typeof VisemeMap     !== 'undefined') ? VisemeMap     : null;
      const FallbackClass = (typeof AmplitudeFallback !== 'undefined') ? AmplitudeFallback : null;

      if (!ClockClass || !MapClass || !FallbackClass) {
        console.warn('[HybridLipSync] One or more dependencies not loaded. Check script order.');
      }

      // Create sub-components
      this._clock = ClockClass ? new ClockClass({
        sampleRate:   this._sampleRate,
        mouthDelayMs: this._mouthDelayMs,
        debug:        this._debug,
      }) : null;

      this._map = MapClass ? new MapClass({
        minVisemeMs:   this._minVisemeMs,
        anticipationMs: this._anticipationMs,
        language:      opts.language ?? null,
        debug:         this._debug,
      }) : null;

      this._fallback = (FallbackClass && this._clock) ? new FallbackClass(
        this._clock.analyser,
        this._inputs,
        {
          sensitivity:   this._amplitudeSensitivity,
          smoothing:     0.18,
          neutralInput:  this._neutralInput,
          talkInput:     this._talkInput,
          altInput:      this._altInput,
          debug:         this._debug,
        }
      ) : null;

      // Behavior controller (optional)
      this._behavior = (opts.enableBehavior && this._inputs)
        ? new CharacterBehaviorController(this._inputs, {
            ...(opts.behaviorConfig || {}),
            debug: this._debug,
          })
        : null;

      // Queue: [{startMs, endMs, riveInput, intensity, phoneme}]
      this._queue     = [];
      this._raf       = null;
      this._running   = false;
      this._prevMode  = null;

      // Smoothing state: track current rendered value per Rive input
      this._curValues = {};

      // Callbacks
      this.onModeChange = null;
      this.onViseme     = null;
    }

    // ─── Public API ───────────────────────────────────────────

    /**
     * Feed a Float32Array PCM chunk from Gemini audio.
     * Call this for every inlineData chunk received over the WebSocket.
     *
     * If you receive base64 PCM:
     *   const i16 = base64ToInt16(b64);
     *   const f32 = new Float32Array(i16.length);
     *   for (let i=0; i<i16.length; i++) f32[i] = i16[i]/32768;
     *   ctrl.feedAudio(f32);
     */
    feedAudio(float32Array) {
      if (!this._clock) return;
      this._clock.scheduleChunk(float32Array);
      if (this._debug) {
        console.log(`[HybridLipSync] feedAudio: ${float32Array.length} samples, bufferAhead=${this._clock.bufferAheadSec.toFixed(2)}s`);
      }
    }

    /**
     * Feed a transcript text delta from Gemini outputTranscription.
     * Call this for each delta (NOT the accumulated total — that would re-queue duplicates).
     *
     * @param {string} text            - Transcript delta
     * @param {number} [audioDurationMs] - Actual audio duration, if known. Scales the
     *                                    timeline to match the real audio. Omit to use
     *                                    raw estimated durations.
     */
    feedTranscript(text, audioDurationMs) {
      if (!text || !text.trim() || !this._map) return;

      const nowMs = this._clock ? this._clock.nowMs() : 0;

      // Rebuild VisemeMap with known duration if provided
      const mapOpts = audioDurationMs > 0 ? { audioDurationMs } : {};
      const vm = (typeof VisemeMap !== 'undefined')
        ? new VisemeMap({
            minVisemeMs:    this._minVisemeMs,
            anticipationMs: this._anticipationMs,
            language:       this._map._forceLang,
            debug:          false,
            ...mapOpts,
          })
        : this._map;

      const timeline = vm.fromText(text);
      if (!timeline.length) return;

      // Anchor new entries to end of queue, or to current audio position
      const queueEndMs = this._queue.length > 0
        ? this._queue[this._queue.length - 1].endMs
        : Math.max(nowMs, 0);

      for (const entry of timeline) {
        this._queue.push({
          startMs:   queueEndMs + entry.startMs,
          endMs:     queueEndMs + entry.endMs,
          riveInput: String(entry.riveInput),
          intensity: entry.intensity,
          phoneme:   entry.phoneme,
        });
      }

      if (this._debug) {
        console.log(`[HybridLipSync] feedTranscript: "${text.slice(0,35)}…" → ${timeline.length} visemes, queue=${this._queue.length}`);
      }

      if (this._behavior) this._behavior.reactToEmotion(text);
    }

    /**
     * Reset for next utterance.
     * Call this when turnComplete arrives from Gemini (after a brief delay to let
     * the last visemes finish playing).
     */
    reset() {
      this._queue    = [];
      this._curValues = {};
      if (this._fallback && this._fallback._running) this._fallback.stop();
      if (this._clock) this._clock.reset();
      this._setNeutral();
      if (this._debug) console.log('[HybridLipSync] reset');
    }

    /** Start the RAF loop. Call once after construction. */
    start() {
      if (this._running) return;
      this._running = true;
      if (this._behavior) this._behavior.start();
      this._tick();
      if (this._debug) console.log('[HybridLipSync] started');
    }

    /** Stop and return to neutral. */
    stop() {
      this._running = false;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      if (this._fallback && this._fallback._running) this._fallback.stop();
      if (this._behavior) this._behavior.stop();
      this._setNeutral();
    }

    /** Set character behavior state: 'idle' | 'listening' | 'speaking' | 'thinking' */
    setBehaviorState(state) {
      if (this._behavior) this._behavior.setState(state);
    }

    /** Destroy and release all resources (AudioContext etc.) */
    destroy() {
      this.stop();
      if (this._clock) this._clock.destroy();
    }

    /** Current sync mode: 'text' | 'amplitude' | 'neutral' */
    get mode() { return this._computeMode(); }

    /** AudioClock.nowMs() — current audio position in ms */
    get nowMs() { return this._clock ? this._clock.nowMs() : 0; }

    /** AudioClock debug metrics */
    get metrics() { return this._clock ? this._clock.metrics : null; }

    // ─── Internal tick ─────────────────────────────────────────
    _tick() {
      if (!this._running) return;

      const nowMs = this._clock ? this._clock.nowMs() : 0;
      const mode  = this._computeMode();

      if (mode !== this._prevMode) {
        this._prevMode = mode;
        if (typeof this.onModeChange === 'function') this.onModeChange(mode);
        if (this._debug) console.log('[HybridLipSync] mode →', mode);
      }

      // Prune expired queue entries (keep one extra for blend reference)
      while (this._queue.length > 1 && this._queue[0].endMs < nowMs - 20) {
        this._queue.shift();
      }

      switch (mode) {
        case 'text':
          if (this._fallback && this._fallback._running) this._fallback.stop();
          this._driveQueue(nowMs);
          break;

        case 'amplitude':
          // AmplitudeFallback manages its own Rive output; just start/stop it.
          if (this._fallback && !this._fallback._running) {
            this._fallback.start();
          }
          // Don't call _setNeutral here — fallback handles its own neutral state.
          break;

        case 'neutral':
        default:
          if (this._fallback && this._fallback._running) this._fallback.stop();
          this._setNeutral();
          break;
      }

      this._raf = requestAnimationFrame(() => this._tick());
    }

    _computeMode() {
      const nowMs = this._clock ? this._clock.nowMs() : 0;
      const hasCurrentViseme = this._queue.some(e => e.endMs > nowMs - 30);
      if (hasCurrentViseme) return 'text';

      const audioActive = this._clock && !this._clock.isIdle;
      if (audioActive) return 'amplitude';

      return 'neutral';
    }

    // ─── Viseme queue driver ───────────────────────────────────
    _driveQueue(nowMs) {
      if (!this._queue.length) {
        this._setNeutral();
        return;
      }

      const curr = this._queue[0];
      const next = this._queue[1] || null;

      if (nowMs < curr.startMs) {
        // Not yet time; hold neutral until this viseme starts
        this._setNeutral();
        return;
      }

      const duration = Math.max(1, curr.endMs - curr.startMs);
      const elapsed  = nowMs - curr.startMs;
      const progress = clamp01(elapsed / duration);

      // Ramp 0→intensity with ease-in-out for smooth motion
      const eased = duration < 80 ? easeOut2(progress) : easeInOut3(progress);
      const targetVal = Math.round(curr.intensity * 100 * eased);

      // LERP current value toward target for per-frame smoothing
      const prevVal  = this._curValues[curr.riveInput] || 0;
      const lerpAlpha = clamp01(16 / Math.max(8, this._smoothingMs));
      const smoothVal = Math.round(prevVal + (targetVal - prevVal) * lerpAlpha);

      // Zero all tracked inputs first
      for (const [name, v] of Object.entries(this._curValues)) {
        if (name !== curr.riveInput && v > 0) {
          this._setInput(name, 0);
          this._curValues[name] = 0;
        }
      }
      // Ensure neutral closed input is off while a viseme is active
      this._setInput(this._neutralInput, 0);

      // Set current viseme
      this._setInput(curr.riveInput, smoothVal);
      this._curValues[curr.riveInput] = smoothVal;

      // Blend next viseme at low value during the overlap window (last 25% of duration)
      if (next && progress > 0.75 && next.riveInput !== curr.riveInput) {
        const overlapProgress = (progress - 0.75) / 0.25;
        const nextVal = Math.round(next.intensity * 28 * easeOut2(overlapProgress));
        if (nextVal > 4) {
          this._setInput(next.riveInput, nextVal);
          this._curValues[next.riveInput] = nextVal;
        }
      }

      if (typeof this.onViseme === 'function') this.onViseme(curr.riveInput, smoothVal);

      if (this._clock && this._clock.metrics.firstVisemeMs === null) {
        this._clock.metrics.firstVisemeMs = performance.now();
      }
    }

    _setNeutral() {
      // Zero all tracked mouth inputs
      for (const name of Object.keys(this._curValues)) {
        this._setInput(name, 0);
      }
      this._curValues = {};
      // Activate neutral/closed mouth shape
      this._setInput(this._neutralInput, 100);
    }

    _setInput(name, value) {
      const inp = this._inputs[name];
      if (inp && 'value' in inp) inp.value = clamp(value, 0, 100);
    }
  }

  // Expose CharacterBehaviorController as a static on HybridLipSyncController
  HybridLipSyncController.CharacterBehaviorController = CharacterBehaviorController;

  return HybridLipSyncController;
}));
