/**
 * AudioClock — Web Audio API master timeline for lip-sync.
 *
 * Why: Date.now() drifts relative to actual audio playback because the
 * browser's audio render thread runs on a separate clock. Using
 * AudioContext.currentTime guarantees the timeline matches what the
 * speaker is hearing.
 *
 * Usage:
 *   const clock = new AudioClock();
 *   clock.onPlaybackStart = (ctxTimeSeconds) => { ... };
 *   clock.scheduleChunk(pcmFloat32, durationSeconds);
 *   const ms = clock.nowMs(); // audio-clock milliseconds since playback start
 */

(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else global.AudioClock = factory();
}(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const OUT_RATE = 24000;

  class AudioClock {
    /**
     * @param {object} opts
     * @param {number} [opts.sampleRate=24000]    - PCM sample rate
     * @param {number} [opts.mouthDelayMs=0]      - Add/subtract to compensate for device latency.
     *                                              Positive = delay mouth start (audio arrives late).
     *                                              Negative = advance mouth start (audio arrives early).
     * @param {boolean} [opts.debug=false]
     */
    constructor(opts = {}) {
      this._rate       = opts.sampleRate  || OUT_RATE;
      this._delayMs    = opts.mouthDelayMs || 0;
      this._debug      = !!opts.debug;

      this._ctx        = null;
      this._analyser   = null;
      this._nextPlayAt = 0;     // next Web Audio scheduled start time (seconds)
      this._playStart  = 0;     // audioCtx.currentTime when first chunk was scheduled
      this._started    = false;

      // Public hooks
      this.onPlaybackStart = null;  // (ctxTime) => void
      this.onEnded         = null;  // () => void

      // Debug metrics
      this.metrics = {
        firstAudioByteMs:  null,
        playbackStartMs:   null,
        firstVisemeMs:     null,
        driftSamples:      [],
        averageDriftMs:    0,
        maxDriftMs:        0,
      };
    }

    /** Ensure AudioContext is created and resumed */
    ensureCtx() {
      if (this._ctx) {
        if (this._ctx.state === 'suspended') this._ctx.resume();
        return;
      }
      this._ctx      = new AudioContext({ sampleRate: this._rate });
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 512;
      this._analyser.smoothingTimeConstant = 0;
      this._analyser.connect(this._ctx.destination);
    }

    /** Get the underlying AudioContext (create if needed) */
    get ctx() { this.ensureCtx(); return this._ctx; }

    /** Get the AnalyserNode for amplitude analysis */
    get analyser() { this.ensureCtx(); return this._analyser; }

    /**
     * Schedule a Float32 PCM chunk for playback.
     * Returns the exact AudioContext time this chunk will start playing.
     *
     * Timing sync strategy:
     *   - Each chunk is queued back-to-back using nextPlayAt.
     *   - The first chunk sets _playStart so the phoneme timeline anchor is known.
     *   - All viseme times are computed relative to _playStart.
     *   - mouthDelayMs shifts the anchor forward/backward to compensate for device latency.
     */
    scheduleChunk(float32Array) {
      this.ensureCtx();
      const now = this._ctx.currentTime;
      if (this.metrics.firstAudioByteMs === null) {
        this.metrics.firstAudioByteMs = performance.now();
        if (this._debug) console.log('[AudioClock] first audio byte at', this.metrics.firstAudioByteMs.toFixed(1), 'ms');
      }

      // Leave a small gap so we never schedule in the past
      if (this._nextPlayAt < now + 0.01) this._nextPlayAt = now + 0.01;

      const buf = this._ctx.createBuffer(1, float32Array.length, this._rate);
      buf.getChannelData(0).set(float32Array);

      const src = this._ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this._analyser);

      if (!this._started) {
        // Apply mouthDelayMs: shift the anchor by the calibration offset.
        // Positive delay = visemes start later (mouth waits for late audio).
        // Negative delay = visemes start earlier (mouth leads the audio).
        this._playStart = this._nextPlayAt + (this._delayMs / 1000);
        this._started   = true;
        this.metrics.playbackStartMs = performance.now();
        if (this._debug) console.log('[AudioClock] playback starts at ctx time', this._playStart.toFixed(3));
        if (typeof this.onPlaybackStart === 'function') this.onPlaybackStart(this._playStart);
      }

      src.start(this._nextPlayAt);
      this._nextPlayAt += buf.duration;
      return this._nextPlayAt - buf.duration; // return the actual start time
    }

    /**
     * Current audio-clock position in milliseconds since playback started.
     * Use this as the master "now" for all viseme scheduling decisions.
     *
     * How to debug drift:
     *   Compare nowMs() against the expected viseme startMs.
     *   If the mouth always opens too late: decrease mouthDelayMs.
     *   If the mouth always opens too early: increase mouthDelayMs.
     *   averageDriftMs and maxDriftMs show the distribution over the session.
     */
    nowMs() {
      if (!this._ctx || !this._started) return 0;
      return (this._ctx.currentTime - this._playStart) * 1000;
    }

    /**
     * Record drift between expected viseme time and actual playback position.
     * Call this from VisemeScheduler when a viseme is rendered.
     */
    recordDrift(expectedMs, actualMs) {
      const drift = Math.abs(actualMs - expectedMs);
      this.metrics.driftSamples.push(drift);
      if (this.metrics.driftSamples.length > 100) this.metrics.driftSamples.shift();
      const sum = this.metrics.driftSamples.reduce((a, b) => a + b, 0);
      this.metrics.averageDriftMs = sum / this.metrics.driftSamples.length;
      this.metrics.maxDriftMs     = Math.max(...this.metrics.driftSamples);
    }

    /** Reset for a new utterance (does not destroy the AudioContext) */
    reset() {
      this._nextPlayAt = 0;
      this._playStart  = 0;
      this._started    = false;
      this.metrics.firstAudioByteMs  = null;
      this.metrics.playbackStartMs   = null;
      this.metrics.firstVisemeMs     = null;
      this.metrics.driftSamples      = [];
      this.metrics.averageDriftMs    = 0;
      this.metrics.maxDriftMs        = 0;
    }

    /** How many seconds of audio are buffered ahead of now */
    get bufferAheadSec() {
      if (!this._ctx) return 0;
      return Math.max(0, this._nextPlayAt - this._ctx.currentTime);
    }

    /** Current amplitude (0-1) from the AnalyserNode */
    get amplitude() {
      if (!this._analyser) return 0;
      const buf = new Uint8Array(this._analyser.frequencyBinCount);
      this._analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      return (sum / buf.length) / 255;
    }

    /** True when audio buffer has caught up (no more chunks buffered) */
    get isIdle() {
      if (!this._ctx || !this._started) return true;
      return this._ctx.currentTime >= this._nextPlayAt - 0.05;
    }

    destroy() {
      if (this._ctx) { try { this._ctx.close(); } catch (_) {} this._ctx = null; }
    }
  }

  return AudioClock;
}));
