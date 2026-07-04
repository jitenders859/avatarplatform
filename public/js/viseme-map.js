/**
 * VisemeMap — standalone viseme timeline builder.
 *
 * Converts transcript text + audio duration into a timed viseme schedule
 * that can be fed to VisemeScheduler.
 *
 * Phoneme-to-viseme ID mapping (how to change it):
 *   The PHONEME_TO_RIVEGROUP map converts CMU ARPAbet phonemes to one of 10
 *   mouth groups. Group 0 = silence, groups 1-9 = mouth shapes.
 *   To add a language, add entries to the language's G2P map below.
 *   To remap a Rive input, change RIVE_INPUT_BY_GROUP.
 *
 * Usage:
 *   const map = new VisemeMap({ audioDurationMs: 3200 });
 *   const timeline = map.fromText("Hello world");
 *   // Returns: [{ startMs, endMs, riveInput, intensity, phoneme }, ...]
 */

(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else global.VisemeMap = factory();
}(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  // ── Mouth groups: 0 = silence, 1-9 = distinct shapes ─────────
  // These are coarser than Azure-style visemes but work well for
  // real-time text-estimated timing where phoneme duration is approximate.
  const GROUP_SILENCE = 0;
  const GROUP_OPEN    = 1; // aa, aw, ah — wide open
  const GROUP_ROUND   = 2; // ow, oo, uw — rounded
  const GROUP_FLAT    = 3; // ee, ih, iy — flat/spread
  const GROUP_MID     = 4; // eh, er, ay — mid-height
  const GROUP_TEETH   = 5; // s, z, th — teeth visible
  const GROUP_LABIAL  = 6; // p, b, m — lip closure
  const GROUP_FRICATIVE = 7; // f, v — lower-lip+teeth
  const GROUP_BACK    = 8; // k, g, ng — back of throat
  const GROUP_ALVEOLAR= 9; // t, d, n, l — tongue-tip

  // Map phoneme group → Rive input number (100-122)
  // Adjust these if your Rive character uses different input numbers.
  const RIVE_INPUT_BY_GROUP = {
    [GROUP_SILENCE]:   100, // closed/silent
    [GROUP_OPEN]:      101, // wide open vowel
    [GROUP_ROUND]:     108, // rounded O
    [GROUP_FLAT]:      105, // narrow/spread
    [GROUP_MID]:       103, // mid-height
    [GROUP_TEETH]:     106, // teeth visible
    [GROUP_LABIAL]:    107, // lip closure (p/b/m)
    [GROUP_FRICATIVE]: 109, // f/v lower lip
    [GROUP_BACK]:      121, // back consonant
    [GROUP_ALVEOLAR]:  118, // tongue-tip
  };

  // Phoneme → group (CMU ARPAbet)
  const PHONEME_GROUP = {
    // Vowels — open
    AA:GROUP_OPEN, AE:GROUP_OPEN, AH:GROUP_OPEN, AW:GROUP_OPEN,
    // Vowels — round
    AO:GROUP_ROUND, OW:GROUP_ROUND, UH:GROUP_ROUND, UW:GROUP_ROUND, OY:GROUP_ROUND,
    // Vowels — flat/spread
    IH:GROUP_FLAT, IY:GROUP_FLAT,
    // Vowels — mid
    EH:GROUP_MID, ER:GROUP_MID, EY:GROUP_MID, AY:GROUP_MID,
    // Labials (lip closure)
    P:GROUP_LABIAL, B:GROUP_LABIAL, M:GROUP_LABIAL,
    // Labiodentals
    F:GROUP_FRICATIVE, V:GROUP_FRICATIVE,
    // Dentals
    TH:GROUP_TEETH, DH:GROUP_TEETH,
    // Sibilants
    S:GROUP_TEETH, Z:GROUP_TEETH, SH:GROUP_TEETH, ZH:GROUP_TEETH,
    CH:GROUP_TEETH, JH:GROUP_TEETH,
    // Alveolar
    T:GROUP_ALVEOLAR, D:GROUP_ALVEOLAR, N:GROUP_ALVEOLAR, L:GROUP_ALVEOLAR,
    // Velar/back
    K:GROUP_BACK, G:GROUP_BACK, NG:GROUP_BACK,
    // Glides
    W:GROUP_ROUND, Y:GROUP_FLAT,
    // Approximants
    R:GROUP_MID, HH:GROUP_OPEN,
    // Pauses
    SP:GROUP_SILENCE, PAU:GROUP_SILENCE, SIL:GROUP_SILENCE,
  };

  // Base duration weights per group (ms, before scaling to audio duration)
  const GROUP_DURATION_BASE = {
    [GROUP_SILENCE]:   90,
    [GROUP_OPEN]:     120,
    [GROUP_ROUND]:    110,
    [GROUP_FLAT]:      90,
    [GROUP_MID]:      100,
    [GROUP_TEETH]:     75,
    [GROUP_LABIAL]:    65,
    [GROUP_FRICATIVE]: 80,
    [GROUP_BACK]:      70,
    [GROUP_ALVEOLAR]:  70,
  };

  // ── Language-specific timing adjustments ─────────────────────
  // To add a language: add entries here and add its G2P function below.
  const LANG_TIMING = {
    hindi:    { vowelHoldMultiplier: 1.25, consonantSnapMs: 55, mouthOpenBoost: 1.1 },
    punjabi:  { vowelHoldMultiplier: 1.2,  consonantSnapMs: 55, mouthOpenBoost: 1.1 },
    arabic:   { vowelHoldMultiplier: 1.15, consonantSnapMs: 45, mouthOpenBoost: 1.15, roundedLipBoost: 1.2 },
    spanish:  { vowelHoldMultiplier: 1.1,  consonantSnapMs: 50, mouthOpenBoost: 1.05 },
    french:   { vowelHoldMultiplier: 1.1,  consonantSnapMs: 50, mouthOpenBoost: 1.0 },
    english:  { vowelHoldMultiplier: 1.0,  consonantSnapMs: 60, mouthOpenBoost: 1.0 },
    default:  { vowelHoldMultiplier: 1.0,  consonantSnapMs: 60, mouthOpenBoost: 1.0 },
  };

  // ── Simple G2P (text → phoneme groups) ───────────────────────
  const COMMON_WORDS_EN = {
    the:['DH','AH'], a:['AH'], an:['AH','N'], and:['AE','N','D'],
    is:['IH','Z'], it:['IH','T'], in:['IH','N'], of:['AH','V'],
    to:['T','UW'], be:['B','IY'], that:['DH','AE','T'],
    he:['HH','IY'], she:['SH','IY'], we:['W','IY'], you:['Y','UW'],
    i:['AY'], me:['M','IY'], my:['M','AY'],
    hello:['HH','AH','L','OW'], hi:['HH','AY'],
    yes:['Y','EH','S'], no:['N','OW'],
    ok:['OW','K','EY'], okay:['OW','K','EY'],
    please:['P','L','IY','Z'], thank:['TH','AE','NG','K'],
    sorry:['S','AO','R','IY'], help:['HH','EH','L','P'],
  };

  function englishG2P(text) {
    const groups = [];
    const words = text.toLowerCase().replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(Boolean);
    for (const word of words) {
      const clean = word.replace(/[^a-z]/g, '');
      if (!clean) continue;
      const known = COMMON_WORDS_EN[clean];
      if (known) {
        for (const ph of known) groups.push({ group: PHONEME_GROUP[ph] ?? GROUP_MID, phoneme: ph });
      } else {
        // Letter-level fallback
        for (const ch of clean) {
          const ph = { a:'AH',e:'EH',i:'IH',o:'OW',u:'UH',y:'IY',
                       b:'B',c:'K',d:'D',f:'F',g:'G',h:'HH',j:'JH',k:'K',
                       l:'L',m:'M',n:'N',p:'P',q:'K',r:'R',s:'S',t:'T',
                       v:'V',w:'W',x:'K',z:'Z' }[ch];
          if (ph) groups.push({ group: PHONEME_GROUP[ph] ?? GROUP_MID, phoneme: ph });
        }
      }
      groups.push({ group: GROUP_SILENCE, phoneme: 'SP', isBoundary: true });
    }
    return groups;
  }

  function detectLang(text) {
    const s = text.trim();
    if (!s) return 'english';
    let deva=0, arab=0, lat=0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x0900 && cp <= 0x097F) deva++;
      else if (cp >= 0x0600 && cp <= 0x06FF) arab++;
      else if ((cp >= 0x41 && cp <= 0x7A) || (cp >= 0xC0 && cp <= 0x24F)) lat++;
    }
    const total = deva + arab + lat || 1;
    if (deva / total > 0.3) return 'hindi';
    if (arab / total > 0.3) return 'arabic';
    if (/[áéíóúüñ¿¡]/.test(s)) return 'spanish';
    if (/[àâçèéêëîïôùûü]/.test(s)) return 'french';
    return 'english';
  }

  class VisemeMap {
    /**
     * @param {object} opts
     * @param {number} [opts.audioDurationMs]  - Actual audio duration to scale the timeline to.
     *                                          If omitted, raw estimated durations are used.
     * @param {number} [opts.minVisemeMs=45]   - Minimum duration per viseme (prevents jitter on fast consonants).
     * @param {number} [opts.anticipationMs=40]- Start mouth transition this many ms before the phoneme starts.
     * @param {string} [opts.language]         - Force language ('english','hindi','arabic', etc.)
     * @param {boolean}[opts.debug=false]
     */
    constructor(opts = {}) {
      this._audioDuration  = opts.audioDurationMs ?? null;
      this._minVisemeMs    = opts.minVisemeMs     ?? 45;
      this._anticipationMs = opts.anticipationMs  ?? 40;
      this._forceLang      = opts.language        ?? null;
      this._debug          = !!opts.debug;
    }

    /**
     * Build a viseme timeline from text.
     *
     * @param {string} text - The transcript text
     * @returns {Array<{startMs, endMs, riveInput, intensity, phoneme, group}>}
     *
     * How phoneme-to-viseme mapping works:
     *   1. Detect language from character set.
     *   2. Convert text to a sequence of phoneme groups (0-9).
     *   3. Merge adjacent identical groups (coarticulation).
     *   4. Assign base durations weighted by phoneme importance.
     *   5. If audioDurationMs is known, scale all durations to fit.
     *   6. Apply anticipation: subtract anticipationMs from each startMs.
     *   7. Apply min hold: extend any entry shorter than minVisemeMs.
     */
    fromText(text) {
      if (!text || !text.trim()) return [];

      const lang = this._forceLang || detectLang(text);
      const timing = LANG_TIMING[lang] || LANG_TIMING.default;

      // G2P: text → [{group, phoneme}]
      const rawGroups = englishG2P(text); // multilingual extension point

      if (rawGroups.length === 0) return [];

      // Coarticulation: merge consecutive identical groups
      const merged = [];
      for (const item of rawGroups) {
        if (merged.length && merged[merged.length - 1].group === item.group && !item.isBoundary) {
          merged[merged.length - 1].count = (merged[merged.length - 1].count || 1) + 1;
          merged[merged.length - 1].phonemes = (merged[merged.length - 1].phonemes || [merged[merged.length - 1].phoneme]);
          merged[merged.length - 1].phonemes.push(item.phoneme);
        } else {
          merged.push({ ...item, count: 1 });
        }
      }

      // Compute raw durations
      let rawEntries = [];
      let cursor = 0;
      for (const item of merged) {
        let base = GROUP_DURATION_BASE[item.group] ?? 80;
        // Apply language timing adjustments
        const isVowel = item.group >= GROUP_OPEN && item.group <= GROUP_MID;
        if (isVowel) base *= timing.vowelHoldMultiplier;
        else if (item.group !== GROUP_SILENCE) base = Math.min(base, timing.consonantSnapMs * 1.5);
        // Scale by count (merged groups get proportionally longer)
        base *= Math.min(item.count, 3);
        // Enforce minimum hold
        base = Math.max(base, this._minVisemeMs);

        const riveInput = RIVE_INPUT_BY_GROUP[item.group] ?? 100;
        // Intensity: vowels and open sounds get full intensity; closures less
        const intensity = item.group === GROUP_SILENCE ? 0
          : item.group === GROUP_LABIAL ? 0.7
          : item.group >= GROUP_OPEN && item.group <= GROUP_MID ? (1.0 * timing.mouthOpenBoost)
          : 0.75;

        rawEntries.push({
          startMs: cursor,
          endMs: cursor + base,
          durationMs: base,
          riveInput,
          intensity,
          phoneme: item.phonemes ? item.phonemes.join('+') : item.phoneme,
          group: item.group,
        });
        cursor += base;
      }

      const rawTotalMs = cursor;

      // Scale to fit audio duration (if known)
      if (this._audioDuration && this._audioDuration > 0 && rawTotalMs > 0) {
        const scale = this._audioDuration / rawTotalMs;
        rawEntries = rawEntries.map(e => ({
          ...e,
          startMs:    e.startMs    * scale,
          endMs:      e.endMs      * scale,
          durationMs: e.durationMs * scale,
        }));
      }

      // Apply anticipation: mouth starts moving anticipationMs before the phoneme
      // This is the "pre-roll" that makes speech look natural instead of reactive.
      //
      // How to change anticipation:
      //   - Increase anticipationMs for more "anticipatory" mouth shapes (Duolingo uses ~40ms)
      //   - Decrease it if mouth moves noticeably too early
      //   - Set to 0 to disable
      const ant = this._anticipationMs;
      const timeline = rawEntries
        .filter(e => e.group !== GROUP_SILENCE) // don't animate silence entries
        .map(e => ({
          ...e,
          startMs: Math.max(0, e.startMs - ant),
          endMs:   e.endMs,
        }));

      if (this._debug) {
        console.log(`[VisemeMap] lang=${lang}, ${timeline.length} visemes, totalMs=${rawTotalMs.toFixed(0)}`);
      }

      return timeline;
    }

    /** Expose constants for external tools */
    static get RIVE_INPUT_BY_GROUP() { return { ...RIVE_INPUT_BY_GROUP }; }
    static get PHONEME_GROUP()       { return { ...PHONEME_GROUP }; }
  }

  return VisemeMap;
}));

// ── Test phrases for each language (for manual QA) ────────────
// EN: "Hello, how are you today? I am doing great."
// HI: "नमस्ते, आप कैसे हैं? मैं ठीक हूं।"
// AR: "مرحبا، كيف حالك؟ أنا بخير."
// ES: "Hola, ¿cómo estás? Estoy muy bien."
// FR: "Bonjour, comment allez-vous? Je vais très bien."
//
// To test each language:
//   const map = new VisemeMap({ audioDurationMs: 3000, debug: true });
//   console.table(map.fromText("Hola, ¿cómo estás?"));
