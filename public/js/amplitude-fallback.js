/**
 * AmplitudeFallback — drives mouth movement from audio amplitude
 * when no phoneme/viseme timeline is available.
 *
 * This is the "dumb but reliable" layer. It runs whenever:
 *   - The AI is speaking but no transcript has arrived yet
 *   - Viseme scheduling has a gap (e.g. during network buffering)
 *   - The user has explicitly chosen amplitude-only mode
 *
 * How it works:
 *   1. Reads frequency data from an AnalyserNode every RAF tick.
 *   2. Computes a smoothed amplitude in 3 frequency bands (low/mid/high).
 *   3. Maps amplitude to a set of Rive inputs representing jaw/talk movement.
 *   4. Adds random micro-variation to prevent mechanical appearance.
 *
 * Integration:
 *   const fallback = new AmplitudeFallback(analyserNode, riveInputs);
 *   fallback.start();
 *   fallback.stop(); // returns mouth to neutral
 */

(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else global.AmplitudeFallback = factory();
}(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  function clamp01(v) { return Math.max(0, Math.min(1, v || 0)); }

  class AmplitudeFallback {
    /**
     * @param {AnalyserNode} analyser - Web Audio AnalyserNode
     * @param {object} riveInputs     - Map of input name → Rive StateMachineInput
     * @param {object} opts
     * @param {number}  [opts.sensitivity=1.0]  - Amplitude multiplier (0.5 = subtle, 2.0 = exaggerated)
     * @param {number}  [opts.smoothing=0.2]    - LERP alpha for amplitude smoothing (0=sluggish, 1=instant)
     * @param {number}  [opts.minValue=5]       - Minimum Rive input value when speaking
     * @param {number}  [opts.maxValue=85]      - Maximum Rive input value at peak amplitude
     * @param {number}  [opts.neutralInput=100] - Rive input name for silence/neutral (mouth closed)
     * @param {number}  [opts.talkInput=101]    - Rive input name for talking/jaw-open shape
     * @param {number}  [opts.altInput=105]     - Rive input name for secondary mouth shape
     * @param {number}  [opts.noiseHz=4]        - Micro-variation frequency in Hz (0 = no noise)
     * @param {boolean} [opts.debug=false]
     */
    constructor(analyser, riveInputs, opts = {}) {
      this._analyser    = analyser;
      this._inputs      = riveInputs;
      this._sensitivity = opts.sensitivity    ?? 1.0;
      this._smoothing   = opts.smoothing      ?? 0.2;
      this._minValue    = opts.minValue       ?? 5;
      this._maxValue    = opts.maxValue       ?? 85;
      this._neutralName = String(opts.neutralInput ?? 100);
      this._talkName    = String(opts.talkInput    ?? 101);
      this._altName     = String(opts.altInput     ?? 105);
      this._noiseHz     = opts.noiseHz        ?? 4;
      this._debug       = !!opts.debug;

      this._raf         = null;
      this._running     = false;
      this._smoothAmp   = 0;
      this._noisePhase  = 0;

      // Separate smoothed amplitude per band
      this._bands = { low: 0, mid: 0, high: 0 };
    }

    start() {
      if (this._running) return;
      this._running = true;
      this._tick();
      if (this._debug) console.log('[AmplitudeFallback] started');
    }

    stop() {
      this._running = false;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      this._setNeutral();
      if (this._debug) console.log('[AmplitudeFallback] stopped');
    }

    _tick() {
      if (!this._running) return;
      this._update();
      this._raf = requestAnimationFrame(() => this._tick());
    }

    _update() {
      if (!this._analyser) return;

      const buf = new Uint8Array(this._analyser.frequencyBinCount);
      this._analyser.getByteFrequencyData(buf);

      // Three frequency bands: low (speech fundamentals), mid (vowels), high (consonants)
      const binHz = 24000 / (this._analyser.fftSize);
      const bandVal = (lo, hi) => {
        let sum = 0, n = 0;
        const s = Math.max(0, Math.floor(lo / binHz));
        const e = Math.min(buf.length, Math.ceil(hi / binHz));
        for (let i = s; i < e; i++) { sum += buf[i]; n++; }
        return n ? sum / n / 255 : 0;
      };

      const raw = {
        low:  bandVal(80,  600),
        mid:  bandVal(600, 2800),
        high: bandVal(2800, 7000),
      };

      // LERP smooth each band to prevent jitter on fast consonants
      const a = this._smoothing;
      this._bands.low  = this._bands.low  * (1 - a) + raw.low  * a;
      this._bands.mid  = this._bands.mid  * (1 - a) + raw.mid  * a;
      this._bands.high = this._bands.high * (1 - a) + raw.high * a;

      // Combined amplitude weighted toward vowel-range mids
      const amp = clamp01(
        (this._bands.low * 0.3 + this._bands.mid * 0.5 + this._bands.high * 0.2) * this._sensitivity * 4.5
      );

      // Smoothed overall amplitude
      this._smoothAmp = this._smoothAmp * (1 - a) + amp * a;

      if (this._smoothAmp < 0.015) {
        // Silent — return to neutral
        this._setNeutral();
        return;
      }

      // Micro-variation: oscillate secondary shape at noiseHz to break mechanical look
      this._noisePhase += (this._noiseHz * Math.PI * 2) / 60;
      const noise = this._noiseHz > 0 ? (Math.sin(this._noisePhase) * 0.12 + 0.88) : 1;

      const talkValue = Math.round(
        this._minValue + (this._maxValue - this._minValue) * this._smoothAmp * noise
      );
      const altValue = Math.round(talkValue * this._bands.high * 1.5);

      this._setInput(this._neutralName, 0);
      this._setInput(this._talkName,    Math.max(this._minValue, Math.min(this._maxValue, talkValue)));
      if (altValue > 10) this._setInput(this._altName, Math.min(40, altValue));

      if (this._debug && Math.random() < 0.02) {
        console.log('[AmplitudeFallback] amp:', this._smoothAmp.toFixed(3), 'talkValue:', talkValue);
      }
    }

    _setNeutral() {
      this._setInput(this._talkName,    0);
      this._setInput(this._altName,     0);
      this._setInput(this._neutralName, 100);
    }

    _setInput(name, value) {
      const inp = this._inputs[name];
      if (inp) inp.value = Math.max(0, Math.min(100, value));
    }
  }

  return AmplitudeFallback;
}));
