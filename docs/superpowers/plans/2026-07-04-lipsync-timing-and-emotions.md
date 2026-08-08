# Lip-sync Timing Accuracy & Multilingual Emotions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rive mouth timing track real scheduled audio instead of a fixed-offset guess, and give `CharacterBehaviorController` richer, multilingual, non-double-firing emotion reactions — then actually turn the behavior controller on in the production embed widget.

**Architecture:** All logic changes live in `public/lipsync-sdk.js` (the production SDK, loaded by `embed.html` via the minified build `public/lipsync-sdk.min.js`). One additional one-line change enables the feature in `public/embed.html`, which today never activates `CharacterBehaviorController` at all.

**Tech Stack:** Vanilla JS (no framework, no test runner in this repo — see Testing Approach below), Web Audio API, Rive runtime, Gemini Live WebSocket API.

**Spec:** `docs/superpowers/specs/2026-07-04-lipsync-timing-and-emotions-design.md`

---

## Testing Approach

This repo has zero automated JS test infrastructure (no Jest/Vitest/node:test files anywhere), and the code under change is fundamentally browser-integration code (`AudioContext`, live WebSocket audio/transcript timing, Rive state-machine inputs) that would require a large new mocking harness to unit-test meaningfully. Per the approved spec's own Testing section, verification here is **manual QA against the running app**, using the widget's existing on-screen debug UI (viseme pill, lang pill) plus temporary console logging that is added and removed within the same task. This matches the codebase's existing convention (there is no established test pattern to follow instead).

**Prerequisite for all manual QA below:** a working local instance per `project.md` Quick Start — `npm install`, `.env` configured with a real `GEMINI_API_KEY`, Supabase schema applied, `npm run dev` running, and at least one project created in the dashboard with a character assigned. Get the project's public embed URL from the dashboard (Project → Widget tab) — it looks like `http://localhost:8080/e/<publicId>`.

---

## File Structure

- Modify: `public/lipsync-sdk.js` — all timing and emotion logic (Tasks 1–2)
- Modify: `public/embed.html:223-246` — add `enableBehavior: true` so the work is live (Task 3)
- Generated (gitignored, not committed): `public/lipsync-sdk.min.js` / `.map` — rebuilt via `npm run build` (terser) after every source change, since `embed.html` loads the **minified** file, not the source

---

### Task 1: Byte-clock-windowed viseme timing

**Files:**
- Modify: `public/lipsync-sdk.js:971` (constructor state)
- Modify: `public/lipsync-sdk.js:1433-1495` (`_scheduleFromText`)
- Modify: `public/lipsync-sdk.js:1685-1690` and `:1693-1697` (turn-complete / interrupted resets)

- [ ] **Step 1: Add the new timing-anchor state field**

In the constructor, right after `this._audioStart = 0;` (line 971), add:

```js
      this._audioStart   = 0;
      this._lastTextAnchorMs = 0; // scheduled-audio ms at the last processed transcript delta
```

- [ ] **Step 2: Replace `_scheduleFromText` with the windowed-scaling version**

Replace the entire existing method (lines 1433-1495) with:

```js
    _scheduleFromText(text) {
      if (!text || !text.trim()) return;

      const multiIds = anyTextToAzureIds(text, this._el.langPill);
      let entries;

      if (multiIds !== null) {
        const MIN=55,MAX=210,MIN_SIL=130;
        const filtered=[];
        for(const {azId,forceDurMs} of multiIds){
          let dur=forceDurMs||Math.max(MIN,Math.min(MAX,Math.round(80+(AZ_IMPORTANCE[azId]||0.3)*100)));
          if(azId===0){if(dur>=MIN_SIL)filtered.push({azId:0,dur});continue;}
          filtered.push({azId,dur});
        }
        const merged=[];
        for(const item of filtered){
          if(merged.length&&merged[merged.length-1].azId===item.azId)
            merged[merged.length-1].dur=Math.min(MAX,merged[merged.length-1].dur+item.dur);
          else merged.push({...item});
        }
        const CLOSURE=new Set([0,21]);
        entries=[]; let cursor=0;
        for(let i=0;i<merged.length;i++){
          const {azId,dur}=merged[i];
          const isClosure=CLOSURE.has(azId);
          let blendWith={};
          if(!isClosure){
            const prev=i>0?merged[i-1]:null;
            const next=i<merged.length-1?merged[i+1]:null;
            if(prev&&!CLOSURE.has(prev.azId)&&prev.azId!==azId) blendWith[prev.azId]=38;
            if(next&&!CLOSURE.has(next.azId)&&next.azId!==azId) blendWith[next.azId]=28;
          }
          entries.push({azId,startMs:cursor,durationMs:dur,blendWith});
          cursor+=dur;
        }
      } else {
        entries = phonemesToSchedule(textToPhonemes(text));
      }

      // ── Window-based duration scaling ──────────────────────────
      // Gemini Live gives no phoneme timestamps, but a PCM chunk's duration is
      // exact (bytes/48000s), and _playPCM already accumulates that into
      // _nextPlayAt. Use the audio scheduled since the *previous* transcript
      // delta as this delta's real time budget, and scale the G2P-estimated
      // durations to fit it — instead of guessing a fixed +150ms offset.
      const rawTotalMs = entries.reduce((sum, e) => sum + e.durationMs, 0);
      if (this._audioStart > 0 && rawTotalMs > 0) {
        const scheduledMs = (this._nextPlayAt - this._audioStart) * 1000;
        const windowMs = scheduledMs - this._lastTextAnchorMs;
        // Only trust the window if it's plausible; otherwise fall back to
        // the original unscaled stacking below (never worse than today).
        if (windowMs >= 80 && windowMs <= 4000) {
          const scale = windowMs / rawTotalMs;
          for (const e of entries) {
            e.startMs    *= scale;
            e.durationMs *= scale;
          }
          if (this._opts.debugTiming) {
            console.log(`[LipsyncAvatar] timing window=${windowMs.toFixed(0)}ms raw=${rawTotalMs.toFixed(0)}ms scale=${scale.toFixed(2)}`);
          }
        }
        this._lastTextAnchorMs = scheduledMs;
      }

      const queueEndMs = this._schedQueue.length > 0
        ? this._schedQueue[this._schedQueue.length-1].startMs +
          this._schedQueue[this._schedQueue.length-1].durationMs
        : 0;
      const audioOffsetMs = this._audioStart > 0
        ? (this._audioCtx.currentTime - this._audioStart) * 1000 + 150
        : 0;
      const base = Math.max(queueEndMs, audioOffsetMs);

      const ant    = this._opts.anticipationMs || 0;
      const minMs  = this._opts.minVisemeMs    || 0;
      for (const e of entries) {
        // Enforce minimum hold on non-silence visemes
        if (minMs > 0 && e.azId !== 0 && e.durationMs < minMs) e.durationMs = minMs;
        // Anticipation: mouth starts ant ms before the scheduled phoneme.
        // Math.max(base, ...) prevents pushing entries before the current audio position.
        this._schedQueue.push({
          ...e,
          startMs: Math.max(base, base + e.startMs - ant),
          endMs:   base + e.startMs + e.durationMs,
        });
      }
      if (!this._schedRaf) this._driveSchedule();
    }
```

Note: this step adds a temporary `opts.debugTiming` flag purely for Step 5's manual verification. It is removed in Step 7.

- [ ] **Step 3: Reset the new anchor on turn-complete**

Find (around line 1685):

```js
          setTimeout(() => {
            this._schedQueue = [];
            this._audioStart = 0;
            this._setAzureViseme(0, { immediate: true });
            if (this._behaviorCtrl) this._behaviorCtrl.setState('idle');
          }, 400);
```

Replace with:

```js
          setTimeout(() => {
            this._schedQueue = [];
            this._audioStart = 0;
            this._lastTextAnchorMs = 0;
            this._setAzureViseme(0, { immediate: true });
            if (this._behaviorCtrl) this._behaviorCtrl.setState('idle');
          }, 400);
```

- [ ] **Step 4: Reset the new anchor on interruption**

Find (around line 1693):

```js
        if (content.interrupted) {
          this._nextPlayAt = this._audioCtx.currentTime;
          this._schedQueue = [];
          this._audioStart  = 0;
          this._setAzureViseme(0, { immediate: true });
```

Replace with:

```js
        if (content.interrupted) {
          this._nextPlayAt = this._audioCtx.currentTime;
          this._schedQueue = [];
          this._audioStart  = 0;
          this._lastTextAnchorMs = 0;
          this._setAzureViseme(0, { immediate: true });
```

- [ ] **Step 5: Build and manually verify timing**

Run: `npm run build`
Expected: regenerates `public/lipsync-sdk.min.js` with no errors.

Start the app (`npm run dev` if not already running), open the project's embed URL in a browser, open devtools console, and run:

```js
avatar._opts.debugTiming = true;
```

Connect the session and send a few messages of varying length (a one-word reply, a full sentence, a multi-sentence answer). For each model reply, watch the console for lines like:

```
[LipsyncAvatar] timing window=812ms raw=734ms scale=1.11
```

Expected: `scale` values mostly land between roughly `0.4` and `2.5`. Values wildly outside that (e.g. `0.02` or `40`) would mean the window heuristic is misfiring — if you see that, stop and re-check Step 2's window bounds (`80`–`4000`) against what's actually happening before continuing. Also subjectively confirm the character's mouth stops moving at roughly the same moment the audio finishes, across both short and long replies.

- [ ] **Step 6: Remove the temporary debug flag from the manual test**

No code change needed — `debugTiming` only logs when explicitly set to `true` from the console, so nothing further to revert in the file itself.

- [ ] **Step 7: Commit**

```bash
git add public/lipsync-sdk.js
git commit -m "feat(lipsync): scale viseme timing to real scheduled audio window"
```

---

### Task 2: Richer, multilingual emotion reactions

**Files:**
- Modify: `public/lipsync-sdk.js:688-861` (`CharacterBehaviorController`)
- Modify: `public/lipsync-sdk.js:1657` (`reactToEmotion` call site)

- [ ] **Step 1: Add the multilingual emotion keyword table**

Immediately before the `CharacterBehaviorController` class definition (before line 701, i.e. right after the class's header comment block that starts around line 688), add:

```js
  // Emotion keyword patterns, keyed by the same language codes detectLanguage()
  // returns. Best-effort translations for common conversational words — override
  // or extend any language via opts.behaviorConfig.emotionKeywords, e.g.
  // { english: { happy: /\b(nice)\b/i } } replaces only the English "happy" pattern.
  // Word-boundary \b is only used for Latin-script languages, since JS \w is
  // ASCII-only and \b never matches inside non-Latin scripts.
  //
  // NOTE: detectLanguage() (defined above, ~line 322) only ever returns:
  // english, devanagari, arabic, japanese, chinese, cyrillic, bengali, spanish,
  // french, german, portuguese. It has no 'indonesian' branch (the switch in
  // anyTextToAzureIds has a dead 'indonesian' case for the same reason) — so an
  // 'indonesian' entry here would never be selected. Not added.
  const DEFAULT_EMOTION_KEYWORDS = {
    english:    { surprised: /\b(wow|incredible|really|oh my|fascinating|remarkable)\b/i,
                  happy:     /\b(great|excellent|wonderful|amazing|love|thanks|glad|happy|awesome|perfect)\b/i,
                  sad:       /\b(sorry|unfortunately|problem|issue|error|fail|mistake|wrong|trouble)\b/i },
    spanish:    { surprised: /\b(increíble|vaya|en serio|sorprendente|asombroso)\b/i,
                  happy:     /\b(genial|excelente|maravilloso|encantador|gracias|feliz|perfecto|estupendo)\b/i,
                  sad:       /\b(lo siento|desafortunadamente|problema|error|disculpa|lamentablemente)\b/i },
    french:     { surprised: /\b(incroyable|vraiment|waouh|étonnant|fascinant)\b/i,
                  happy:     /\b(génial|excellent|merveilleux|super|merci|content|parfait|formidable)\b/i,
                  sad:       /\b(désolé|malheureusement|problème|erreur|dommage)\b/i },
    german:     { surprised: /\b(unglaublich|wirklich|erstaunlich|faszinierend)\b/i,
                  happy:     /\b(großartig|ausgezeichnet|wunderbar|super|danke|froh|perfekt)\b/i,
                  sad:       /\b(entschuldigung|leider|problem|fehler|schade)\b/i },
    portuguese: { surprised: /\b(incrível|uau|sério|surpreendente|fascinante)\b/i,
                  happy:     /\b(ótimo|excelente|maravilhoso|adorável|obrigado|feliz|perfeito)\b/i,
                  sad:       /\b(desculpe|infelizmente|problema|erro|lamento)\b/i },
    devanagari: { surprised: /(अविश्वसनीय|वाकई|वाह|आश्चर्यजनक)/,
                  happy:     /(बढ़िया|शानदार|अद्भुत|धन्यवाद|खुश)/,
                  sad:       /(माफ़ करना|दुर्भाग्य से|समस्या|गलती|क्षमा करें)/ },
    arabic:     { surprised: /(مذهل|حقا|واو|مثير للدهشة)/,
                  happy:     /(رائع|ممتاز|جميل|شكرا|سعيد|مثالي)/,
                  sad:       /(آسف|للأسف|مشكلة|خطأ|عذرا)/ },
    bengali:    { surprised: /(অবিশ্বাস্য|সত্যিই|বাহ|আশ্চর্যজনক)/,
                  happy:     /(দুর্দান্ত|চমৎকার|ধন্যবাদ|খুশি|নিখুঁত)/,
                  sad:       /(দুঃখিত|দুর্ভাগ্যবশত|সমস্যা|ভুল)/ },
    cyrillic:   { surprised: /(невероятно|правда|ух ты|удивительно|поразительно)/i,
                  happy:     /(отлично|прекрасно|замечательно|спасибо|рад|идеально|супер)/i,
                  sad:       /(извините|к сожалению|проблема|ошибка|жаль)/i },
    japanese:   { surprised: /(すごい|本当に|まさか|驚き)/,
                  happy:     /(素晴らしい|最高|ありがとう|嬉しい|完璧)/,
                  sad:       /(ごめんなさい|残念|問題|間違い|すみません)/ },
    chinese:    { surprised: /(真的吗|难以置信|哇|惊人)/,
                  happy:     /(太好了|太棒了|谢谢|开心|完美|很好)/,
                  sad:       /(对不起|抱歉|不幸的是|问题|错误)/ },
  };

  function mergeEmotionKeywords(overrides) {
    const merged = {};
    for (const lang of Object.keys(DEFAULT_EMOTION_KEYWORDS)) {
      merged[lang] = { ...DEFAULT_EMOTION_KEYWORDS[lang], ...((overrides && overrides[lang]) || {}) };
    }
    if (overrides) {
      for (const lang of Object.keys(overrides)) {
        if (!merged[lang]) merged[lang] = { ...overrides[lang] };
      }
    }
    return merged;
  }
```

- [ ] **Step 2: Wire keyword overrides and mood state into the constructor**

Find, in `CharacterBehaviorController`'s constructor:

```js
      this._state   = 'idle';
      this._running = false;
      this._raf     = null;
      this._lastMs  = 0;
      this._breathPhase    = 0;
      this._idleNoisePhase = 0;
      this._nextBlinkMs  = 0;
      this._nextDartMs   = 0;
      this._gestureCooldownMs = 0;
    }
```

Replace with:

```js
      this._state   = 'idle';
      this._running = false;
      this._raf     = null;
      this._lastMs  = 0;
      this._breathPhase    = 0;
      this._idleNoisePhase = 0;
      this._nextBlinkMs  = 0;
      this._nextDartMs   = 0;
      this._gestureCooldownMs = 0;
      this._emotionKeywords = mergeEmotionKeywords(opts.emotionKeywords);
      this._moodSlowUntilMs = 0;
    }
```

- [ ] **Step 3: Slow blinking during a sad mood window**

Find:

```js
    _blinkInterval() { return (this._state === 'idle' ? 3000 : 4500) + Math.random() * 3000; }
```

Replace with:

```js
    _blinkInterval() {
      const base = this._state === 'idle' ? 3000 : 4500;
      const moodMultiplier = performance.now() < this._moodSlowUntilMs ? 1.4 : 1;
      return base * moodMultiplier + Math.random() * 3000;
    }
```

- [ ] **Step 4: Add head-motion accents to surprised and happy, replace empathy with sad**

Find:

```js
    _triggerSmile() {
      if (!this._canGesture()) return;
      this._setNumber('smile', 80 * this._gestureIntensity);
      setTimeout(() => this._setNumber('smile', 0), 1400);
      this._markGesture(2000);
    }

    _triggerBrows() {
      if (!this._canGesture()) return;
      this._setNumber('brows', 65 * this._gestureIntensity);
      setTimeout(() => this._setNumber('brows', 0), 550);
      this._markGesture(900);
    }

    _triggerEmpathy() {
      if (!this._canGesture()) return;
      this._setNumber('headTilt', 10 * this._gestureIntensity);
      setTimeout(() => this._setNumber('headTilt', 0), 1200);
      this._markGesture(2500);
    }
```

Replace with:

```js
    _triggerSmile() {
      if (!this._canGesture()) return;
      this._setNumber('smile', 80 * this._gestureIntensity);
      this._setNumber('headNod', 6 * this._gestureIntensity);
      setTimeout(() => this._setNumber('headNod', 0), 400);
      setTimeout(() => this._setNumber('smile', 0), 1400);
      this._markGesture(2000);
    }

    _triggerBrows() {
      if (!this._canGesture()) return;
      this._setNumber('brows', 65 * this._gestureIntensity);
      this._setNumber('headNod', -12 * this._gestureIntensity);
      setTimeout(() => { this._setNumber('brows', 0); this._setNumber('headNod', 0); }, 550);
      this._markGesture(900);
    }

    _triggerSad() {
      if (!this._canGesture()) return;
      this._setNumber('brows', -30 * this._gestureIntensity);
      this._setNumber('headNod', 10 * this._gestureIntensity);
      this._setNumber('headTilt', 8 * this._gestureIntensity);
      this._moodSlowUntilMs = performance.now() + 2500;
      setTimeout(() => {
        this._setNumber('brows', 0);
        this._setNumber('headNod', 0);
        this._setNumber('headTilt', 0);
      }, 1600);
      this._markGesture(2500);
    }
```

- [ ] **Step 5: Rewrite `reactToEmotion` with language-aware priority matching**

Find:

```js
    reactToEmotion(text) {
      if (!text) return;
      const t = text.toLowerCase();
      if (/\b(wow|incredible|really|oh my|fascinating|remarkable)\b/.test(t)) { this._triggerBrows(); return; }
      if (/\b(great|excellent|wonderful|amazing|love|thanks|glad|happy|awesome|perfect)\b/.test(t)) { this._triggerSmile(); return; }
      if (/\b(sorry|unfortunately|problem|issue|error|fail|mistake|wrong|trouble)\b/.test(t)) { this._triggerEmpathy(); }
      if (/\?/.test(text)) { this._triggerThinkingLook(); }
    }
```

Replace with:

```js
    reactToEmotion(text) {
      if (!text) return;
      const lang  = detectLanguage(text) || 'english';
      const table = this._emotionKeywords[lang] || this._emotionKeywords.english;
      if (table.surprised && table.surprised.test(text)) { this._triggerBrows(); return; }
      if (table.happy     && table.happy.test(text))     { this._triggerSmile(); return; }
      if (table.sad       && table.sad.test(text))       { this._triggerSad(); return; }
      if (/[?？؟]/.test(text)) { this._triggerThinkingLook(); }
    }
```

- [ ] **Step 6: Fix the chunk-boundary keyword-split bug at the call site**

Find (around line 1657):

```js
          if (this._behaviorCtrl) this._behaviorCtrl.reactToEmotion(delta);
```

Replace with:

```js
          if (this._behaviorCtrl) this._behaviorCtrl.reactToEmotion(this._outputTranscriptBuf.slice(-60));
```

- [ ] **Step 7: Build and manually verify emotions**

Run: `npm run build`

On the project's embed URL, open devtools console. With the widget connected (or even before connecting — `_behaviorCtrl` only exists once Rive loads and `enableBehavior` is on, which isn't wired up until Task 3, so **do this step after Task 3's Step 1**), run each of the following and confirm exactly one gesture fires with no double-fire:

```js
avatar._behaviorCtrl.reactToEmotion("Wow, that's incredible!");      // expect: brows + quick head pull-back
avatar._behaviorCtrl._gestureCooldownMs = 0;                          // clear cooldown between manual tests
avatar._behaviorCtrl.reactToEmotion("That's great, thanks so much!"); // expect: smile + head bounce
avatar._behaviorCtrl._gestureCooldownMs = 0;
avatar._behaviorCtrl.reactToEmotion("Sorry, there was a problem.");   // expect: brows down, head tilt/nod down
avatar._behaviorCtrl._gestureCooldownMs = 0;
avatar._behaviorCtrl.reactToEmotion("Sorry, what time is it?");       // expect: ONLY sad fires, not thinking-look too
avatar._behaviorCtrl._gestureCooldownMs = 0;
avatar._behaviorCtrl.reactToEmotion("¡Qué maravilloso, gracias!");    // Spanish happy
avatar._behaviorCtrl._gestureCooldownMs = 0;
avatar._behaviorCtrl.reactToEmotion("désolé, il y a un problème");    // French sad
```

Expected: each call fires exactly the gesture named in its comment, once. The fourth call in particular verifies the priority-order fix (sad no longer co-fires with the question-mark thinking-look).

- [ ] **Step 8: Commit**

```bash
git add public/lipsync-sdk.js
git commit -m "feat(lipsync): multilingual emotion keywords, sad gesture, fix double-fire"
```

---

### Task 3: Enable behavior controller in production + final validation

**Files:**
- Modify: `public/embed.html:223-233`
- Modify: `public/lipsync-sdk.js:2` (version comment)

- [ ] **Step 1: Turn on `CharacterBehaviorController` for the live widget**

Find (around line 223):

```js
    avatar = new LipsyncAvatar({
      container:    '#sdk-host',
      riveSrc:      config.character.rivePath,
      apiKey:       config.apiKey,
      model:        config.model,
      voice:        config.project.voice,
      systemPrompt: systemPromptWithGreeting,

      showVoiceSelect: false, showTranscript: false,
      showTextInput: false,   showBands: false,
      width: 300, height: 300,
```

Replace with:

```js
    avatar = new LipsyncAvatar({
      container:    '#sdk-host',
      riveSrc:      config.character.rivePath,
      apiKey:       config.apiKey,
      model:        config.model,
      voice:        config.project.voice,
      systemPrompt: systemPromptWithGreeting,

      showVoiceSelect: false, showTranscript: false,
      showTextInput: false,   showBands: false,
      width: 300, height: 300,
      enableBehavior: true,
```

- [ ] **Step 2: Bump the SDK version comment**

Find (line 2):

```js
 * LipsyncAvatar SDK  v2.2.0
```

Replace with:

```js
 * LipsyncAvatar SDK  v2.3.0
```

- [ ] **Step 3: Rebuild and run the combined manual smoke test**

Run: `npm run build`

On the project's embed URL: connect, and have a short back-and-forth conversation covering a few cases naturally (ask something that gets a happy/positive answer, ask something that would make the assistant apologize, ask a question, say something surprising). Confirm:
- The character blinks and breathes idly when not speaking (proof `enableBehavior` is now active).
- Mouth movement visually tracks the audio (from Task 1).
- At least one emotion gesture visibly fires during the conversation without the console showing errors.

Also re-run Task 2 Step 7's console script now that `_behaviorCtrl` exists on a live connected instance, to confirm all four categories still work end-to-end (not just via direct method calls).

- [ ] **Step 4: Commit**

```bash
git add public/embed.html public/lipsync-sdk.js
git commit -m "feat(lipsync): enable character behavior controller in production embed widget"
```
