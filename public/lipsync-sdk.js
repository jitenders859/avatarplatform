/*!
 * LipsyncAvatar SDK  v2.2.0
 * Gemini Live · Rive · Multilingual Lip Sync · Knowledge Base
 * - 23 Rive mouth inputs (100-122), video-matched to Azure visemes
 * - Timed ramp logic: active mouth value moves 1→100 across the spoken viseme
 * - Owner-provided knowledge base support
 *
 * Usage:
 *   <script src="lipsync-sdk.js"></script>
 *   const avatar = new LipsyncAvatar({ container: '#el', riveSrc: 'character.riv', apiKey: '...' });
 *   avatar.connect();
 *
 * Or as a module:
 *   import LipsyncAvatar from './lipsync-sdk.js';
 */

(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    global.LipsyncAvatar = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  // ═══════════════════════════════════════════════════════
  //  CONSTANTS
  // ═══════════════════════════════════════════════════════
  const DEFAULT_MODEL    = 'gemini-3.1-flash-live-preview';
  const WS_HOST          = 'generativelanguage.googleapis.com';
  const WS_PATH          = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  const OUT_RATE         = 24000;
  const IN_RATE          = 16000;
  const FFT_SIZE         = 512;
  const ANALYSIS_HZ      = 50;
  const FFT_ALPHA        = 0.35;
  const LERP_ALPHA       = 0.18;
  const MIN_PHONEME_MS   = 55;
  const MAX_PHONEME_MS   = 280;
  const SILENCE_PAUSE_MS = 130;
  const PUNCT_PAUSE_MS   = 280;
  const PHONEMES_PER_SEC = 13.5;
  const SILENCE_ENTER_MS = 140;

  const AZ_LABEL = ['sil','aa','aw','o','ey','er','ih','uw','ow','ao','oy',
                    'ay','h','r','l','s_z','sh_ch','th','f_v','d_t_n','k_g_ng','p_b_m','ng'];

  const AZ_COLOR = [
    '#5a5a78','#d85a30','#d85a30','#185fa5','#ba7517','#1d9e75',
    '#1d9e75','#534ab7','#185fa5','#d85a30','#7c6af5','#7c6af5',
    '#888780','#1d9e75','#5dcaa5','#378add','#378add','#5f5e5a',
    '#639922','#e24b4a','#5dcaa5','#d4537e','#88aacc',
  ];

  // Video-matched Rive input map.
  // Index = Azure-style viseme id (0-22), value = Rive number input name.
  // Important recording note:
  //   - Rive input value 0 means inactive / no mouth pose.
  //   - Values 1-99 move/open the target mouth progressively.
  //   - Value 100 completes/snaps the target mouth pose.
  // v2.2 drives the active mouth as a timed ramp from 1→100 based on
  // the scheduled speech timing, so visemes no longer switch instantly.
  // The recording shows both input 100 and input 107 as closed/silent shapes.
  // 100 is used for silence/pauses; 107 is used for p/b/m lip closures.
  const RIVE_INACTIVE_VALUE   = 0;
  const RIVE_ACTIVE_MIN_VALUE = 1;
  const RIVE_ACTIVE_MAX_VALUE = 100;
  const RIVE_INPUT_BY_AZ = [
    100, // 0  sil      -> closed / silent
    101, // 1  aa       -> wide open vowel
    102, // 2  aw       -> tall open round
    110, // 3  o        -> small rounded O
    103, // 4  ey       -> wide/flat mid vowel
    113, // 5  er       -> mid/r-colored vowel
    105, // 6  ih       -> narrow teeth / small open
    104, // 7  uw       -> tight rounded U/W (107 is closed, so do not use 107 for UW)
    108, // 8  ow       -> rounded open O
    112, // 9  ao       -> wide rounded vowel
    120, // 10 oy       -> OY diphthong
    111, // 11 ay       -> AY diphthong
    119, // 12 h        -> light breath/open mouth
    114, // 13 r        -> R shape
    115, // 14 l        -> L/tongue-tip shape
    106, // 15 s_z      -> teeth / S-Z
    116, // 16 sh_ch    -> SH/CH/J rounded teeth
    117, // 17 th       -> TH
    109, // 18 f_v      -> lower lip + teeth
    118, // 19 d_t_n    -> tongue-tip consonants
    121, // 20 k_g_ng   -> back-tongue consonants
    107, // 21 p_b_m    -> closed lips / silent alternate
    122, // 22 ng       -> NG/back nasal
  ];

  const RIVE_INPUT_LABEL = {
    100:'sil / closed', 101:'aa / wide open', 102:'aw / tall open',
    103:'ey / flat open', 104:'uw / tight round', 105:'ih / narrow teeth',
    106:'s_z / teeth', 107:'p_b_m / closed', 108:'ow / round open',
    109:'f_v / lip teeth', 110:'o / small round', 111:'ay / diphthong',
    112:'ao / wide round', 113:'er', 114:'r', 115:'l', 116:'sh_ch',
    117:'th', 118:'d_t_n', 119:'h', 120:'oy', 121:'k_g_ng', 122:'ng',
  };

  // Duration / scheduling weight only. Higher values get slightly longer
  // mouth time. The final Rive value is now calculated by the timed ramp.
  const AZ_IMPORTANCE = [
    0.00, 1.00, 0.95, 0.85, 0.70, 0.50, 0.50, 0.75, 0.75, 0.95, 0.75,
    0.95, 0.30, 0.40, 0.40, 0.55, 0.55, 0.45, 0.65, 0.40, 0.40, 0.05, 0.40,
  ];

  const VISEME_COUNT = 23;

  function clamp01(v) {
    return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }

  function easeOutCubic(t) {
    t = clamp01(t);
    return 1 - Math.pow(1 - t, 3);
  }

  function easeInOutCubic(t) {
    t = clamp01(t);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  const PHONEME_TO_AZ = {
    // Vowels
    AA:1,AE:1,AH:1,AO:9,AW:2,AY:11,EH:4,ER:5,EY:4,IH:6,IY:6,OW:8,OY:10,UH:7,UW:7,
    // Consonants
    B:21,CH:16,D:19,DH:17,F:18,G:20,HH:12,JH:16,K:20,L:14,M:21,N:19,NG:22,
    P:21,R:13,S:15,SH:16,T:19,TH:17,V:18,W:3,Y:4,Z:15,ZH:16,
    // Pauses
    SP:0,PAU:0,SIL:0,
  };

  const VOICES = [
    {n:'Puck',g:'M',s:'Upbeat'},{n:'Charon',g:'M',s:'Informative'},{n:'Fenrir',g:'M',s:'Excitable'},
    {n:'Orus',g:'M',s:'Firm'},{n:'Perseus',g:'M',s:'Direct'},{n:'Umbriel',g:'M',s:'Easy-going'},
    {n:'Achird',g:'M',s:'Friendly'},{n:'Algieba',g:'M',s:'Smooth'},{n:'Schedar',g:'M',s:'Even-tempered'},
    {n:'Enceladus',g:'M',s:'Breathy'},{n:'Algenib',g:'M',s:'Gravelly'},{n:'Zubenelgenubi',g:'M',s:'Casual'},
    {n:'Sadachbia',g:'M',s:'Lively'},{n:'Sadaltager',g:'M',s:'Knowledgeable'},{n:'Rasalgethi',g:'M',s:'Informative'},
    {n:'Zephyr',g:'F',s:'Bright'},{n:'Autonoe',g:'F',s:'Bright'},{n:'Kore',g:'F',s:'Firm'},
    {n:'Leda',g:'F',s:'Youthful'},{n:'Aoede',g:'F',s:'Breezy'},{n:'Despina',g:'F',s:'Smooth'},
    {n:'Erinome',g:'F',s:'Clear'},{n:'Sulafat',g:'F',s:'Warm'},{n:'Vindemiatrix',g:'F',s:'Gentle'},
    {n:'Gacrux',g:'F',s:'Mature'},{n:'Achernar',g:'F',s:'Soft'},{n:'Laomedeia',g:'F',s:'Upbeat'},
    {n:'Iocaste',g:'F',s:'Informative'},{n:'Callirrhoe',g:'F',s:'Easy-going'},{n:'Pulcherrima',g:'F',s:'Forward'},
  ];

  // ═══════════════════════════════════════════════════════
  //  STYLES — injected once into <head>
  // ═══════════════════════════════════════════════════════
  const SDK_CSS = `
.lsa-root {
  --lsa-bg: #080810;
  --lsa-surface: #0f0f1a;
  --lsa-card: #13131f;
  --lsa-border: #1e1e30;
  --lsa-text: #e8e4f0;
  --lsa-muted: #5a5a78;
  --lsa-accent: #7c6af5;
  --lsa-green: #4ade80;
  --lsa-red: #f87171;
  --lsa-blue: #60a5fa;
  font-family: 'DM Sans','Helvetica Neue',sans-serif;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--lsa-bg);
  border-radius: 16px;
  user-select: none;
  box-sizing: border-box;
}
.lsa-root *, .lsa-root *::before, .lsa-root *::after { box-sizing: border-box; }
.lsa-root.lsa-theme-light {
  --lsa-bg: #f4f4f8;
  --lsa-surface: #ffffff;
  --lsa-card: #f0f0f5;
  --lsa-border: #d0d0e0;
  --lsa-text: #1a1a2e;
  --lsa-muted: #8080a0;
}
.lsa-canvas-wrap {
  position: relative;
  border-radius: 16px;
  overflow: hidden;
  border: 1.5px solid var(--lsa-border);
  background: var(--lsa-card);
  transition: border-color .2s;
  flex-shrink: 0;
}
.lsa-canvas-wrap.lsa-speaking { border-color: #7c6af555; }
.lsa-canvas-wrap.lsa-listening { border-color: #60a5fa55; }
.lsa-canvas { display: block; width: 100%; height: 100%; }
.lsa-placeholder {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px; color: var(--lsa-muted); font-size: 11px;
}
.lsa-header {
  width: 100%; display: flex; align-items: center; gap: 8px;
}
.lsa-status-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--lsa-muted); flex-shrink: 0;
  transition: background .3s, box-shadow .3s;
}
.lsa-status-dot.connected { background: var(--lsa-green); box-shadow: 0 0 8px #4ade8055; }
.lsa-status-dot.speaking  { background: var(--lsa-accent); box-shadow: 0 0 8px #7c6af555; }
.lsa-status-dot.listening { background: var(--lsa-blue); box-shadow: 0 0 8px #60a5fa55; }
.lsa-status-dot.error     { background: var(--lsa-red); box-shadow: 0 0 8px #f8717155; }
.lsa-status-label { font-size: 11px; color: var(--lsa-muted); flex: 1; }
.lsa-viseme-pill {
  font-family: monospace; font-size: 10px;
  padding: 2px 8px; border-radius: 20px;
  border: 1px solid var(--lsa-border);
  color: var(--lsa-muted); transition: color .1s, border-color .1s;
}
.lsa-lang-pill {
  font-family: monospace; font-size: 10px; font-weight: 700;
  padding: 2px 6px; border-radius: 4px;
  background: #111120; border: 1px solid #2a2a4a;
  color: #8888cc; letter-spacing: .06em;
}
.lsa-bands {
  display: flex; gap: 4px; align-items: flex-end;
  height: 24px; width: 100%;
}
.lsa-band {
  flex: 1; border-radius: 2px 2px 0 0;
  min-height: 2px; transition: height .05s;
}
.lsa-controls { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.lsa-row { display: flex; gap: 8px; width: 100%; }
.lsa-btn {
  padding: 10px 14px; border-radius: 8px;
  font-size: 12px; font-weight: 500;
  cursor: pointer; border: 1px solid; transition: all .15s;
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.lsa-btn:disabled { opacity: .35; cursor: not-allowed; }
.lsa-btn-connect {
  flex: 1;
  background: #0a150a; border-color: #1a3a1a; color: #4a7a4a;
}
.lsa-btn-connect.lsa-active {
  background: #1a0a0a; border-color: #aa3030; color: #dd8888;
}
.lsa-btn-mic {
  flex: 1;
  background: #0a0a15; border-color: #1a1a3a; color: #5a5aaa;
}
.lsa-btn-mic.lsa-active {
  background: #1a0a1a; border-color: #8030a0; color: #c060e0;
}
.lsa-input-row {
  display: flex; gap: 8px; width: 100%;
  background: #06060e; border: 1px solid var(--lsa-border);
  border-radius: 8px; padding: 8px 12px;
}
.lsa-text-input {
  flex: 1; background: transparent; border: none;
  color: var(--lsa-text); font-size: 12px; outline: none;
}
.lsa-text-input::placeholder { color: var(--lsa-muted); }
.lsa-text-input:disabled { opacity: .4; }
.lsa-btn-send {
  background: transparent; border: none; border-left: 1px solid var(--lsa-border);
  padding: 0 0 0 10px; color: var(--lsa-accent); font-size: 12px; cursor: pointer;
}
.lsa-btn-send:disabled { opacity: .35; cursor: not-allowed; }
.lsa-voice-wrap {
  display: flex; align-items: center; gap: 6px;
  background: #111120; border: 1px solid #2a2a3a;
  border-radius: 8px; padding: 6px 10px; width: 100%;
}
.lsa-voice-wrap span { font-size: 13px; flex-shrink: 0; }
.lsa-voice-select {
  flex: 1; background: transparent; border: none;
  color: var(--lsa-text); font-size: 11px; outline: none; cursor: pointer;
}
.lsa-voice-select option { background: #1a1a2a; }
.lsa-voice-select:disabled { opacity: .5; cursor: not-allowed; }
.lsa-transcript {
  width: 100%; max-height: 180px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 6px;
  padding-right: 4px;
}
.lsa-transcript::-webkit-scrollbar { width: 4px; }
.lsa-transcript::-webkit-scrollbar-track { background: transparent; }
.lsa-transcript::-webkit-scrollbar-thumb { background: var(--lsa-border); border-radius: 2px; }
.lsa-msg {
  padding: 6px 10px; border-radius: 8px;
  font-size: 11px; line-height: 1.5;
}
.lsa-msg.user   { background:#1a1a2a; border:1px solid #2a2a3a; color:#a0a0cc; align-self:flex-end; max-width:85%; }
.lsa-msg.model  { background:#0f1a0f; border:1px solid #1a2a1a; color:#80a880; align-self:flex-start; max-width:85%; }
.lsa-msg.system { color:#3a3a50; font-size:10px; text-align:center; align-self:center; }
.lsa-error {
  font-size: 11px; color: var(--lsa-red);
  background: #1a0808; border: 1px solid #aa303055;
  padding: 4px 10px; border-radius: 4px;
  display: none; width: 100%; text-align: center;
}
`;

  let _stylesInjected = false;
  function _injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const s = document.createElement('style');
    s.textContent = SDK_CSS;
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════
  //  MULTILINGUAL G2P ENGINES (all wrapped in closures)
  // ═══════════════════════════════════════════════════════

  function detectLanguage(text) {
    const s = text.trim();
    if (!s) return 'english';
    let deva=0,arab=0,jpn=0,han=0,cyr=0,beng=0,lat=0,other=0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp>=0x0900&&cp<=0x097F) deva++;
      else if (cp>=0x0600&&cp<=0x06FF) arab++;
      else if ((cp>=0x3040&&cp<=0x309F)||(cp>=0x30A0&&cp<=0x30FF)) jpn++;
      else if (cp>=0x4E00&&cp<=0x9FFF) han++;
      else if (cp>=0x0400&&cp<=0x04FF) cyr++;
      else if (cp>=0x0980&&cp<=0x09FF) beng++;
      else if ((cp>=0x0041&&cp<=0x007A)||(cp>=0x00C0&&cp<=0x024F)) lat++;
      else if (cp>127) other++;
    }
    const total = deva+arab+jpn+han+cyr+beng+lat+other||1;
    if (deva/total>.3) return 'devanagari';
    if (arab/total>.3) return 'arabic';
    if (jpn/total>.2) return 'japanese';
    if (han/total>.2) {
      if (jpn>0) return 'japanese';
      return 'chinese';
    }
    if (cyr/total>.3) return 'cyrillic';
    if (beng/total>.3) return 'bengali';
    if (lat/total>.3) {
      if (/[áéíóúüñ¿¡]/.test(s)) return 'spanish';
      if (/[àâçèéêëîïôùûü]/.test(s)) return 'french';
      if (/[äöüß]/.test(s)) return 'german';
      if (/[ãõâêîôûç]/.test(s)) return 'portuguese';
      return 'english';
    }
    return 'english';
  }

  const devanagariG2P = (function(){
    const V={'अ':1,'आ':1,'इ':6,'ई':6,'उ':7,'ऊ':7,'ए':4,'ओ':3,'औ':9,'ऑ':3};
    const M={'ा':1,'ि':6,'ी':6,'ु':7,'ू':7,'े':4,'ो':3,'ौ':9,'ॉ':3,'ं':21,'ः':0};
    const C={'क':20,'ख':20,'ग':20,'घ':20,'ङ':20,'च':16,'छ':16,'ज':16,'झ':16,'ञ':19,
      'ट':19,'ठ':19,'ड':19,'ढ':19,'ण':19,'त':19,'थ':17,'द':19,'ध':19,'न':19,
      'प':21,'फ':18,'ब':21,'भ':21,'म':21,'य':4,'र':13,'ल':14,'व':18,
      'श':16,'ष':16,'स':15,'ह':12};
    const CLOSURE_IDS = new Set([0,21]);
    return function(text){
      const ids=[],chars=[...text];let i=0;
      while(i<chars.length){
        const ch=chars[i];
        if(/\s/.test(ch)){ids.push({azId:0,forceDurMs:130});i++;continue;}
        if(/[।!?]/.test(ch)){ids.push({azId:0,forceDurMs:280});i++;continue;}
        if(/[,;]/.test(ch)){ids.push({azId:0,forceDurMs:130});i++;continue;}
        if(ch==='\u094D'){i++;continue;}
        if(V[ch]!==undefined){ids.push({azId:V[ch]});i++;continue;}
        if(M[ch]!==undefined){ids.push({azId:M[ch]});i++;continue;}
        const caz=C[ch];
        if(caz!==undefined){
          ids.push({azId:caz});
          const next=chars[i+1];
          if(next==='\u094D'){i+=2;if(i<chars.length&&C[chars[i]]){ids.push({azId:C[chars[i]]});i++;}continue;}
          if(next&&M[next]!==undefined){ids.push({azId:M[next]});i+=2;}
          else{ids.push({azId:1});i++;}
          continue;
        }
        if(/[a-zA-Z]/.test(ch)){const m={a:1,e:4,i:6,o:3,u:7,b:21,m:21,p:21,n:19,t:19,d:19,k:20,g:20,s:15,r:13,l:14,h:12};ids.push({azId:m[ch.toLowerCase()]??0});}
        i++;
      }
      return ids;
    };
  })();

  const arabicG2P = (function(){
    const L={'ب':21,'پ':21,'م':21,'ف':18,'و':3,'ث':17,'ذ':17,'ظ':17,'ز':15,'س':15,
      'ص':15,'ض':15,'ش':16,'ج':16,'ق':20,'ك':20,'خ':12,'غ':20,'ح':12,'ه':12,
      'ت':19,'ط':19,'د':19,'ن':19,'ل':14,'ر':13,'ي':6,'ى':6,'ع':1};
    const H={'َ':1,'ِ':6,'ُ':7,'ا':1,'إ':1,'أ':1,'آ':1};
    return function(text){
      const ids=[],chars=[...text];let i=0;
      while(i<chars.length){
        const ch=chars[i];
        if(/\s/.test(ch)){ids.push({azId:0,forceDurMs:130});i++;continue;}
        if(/[.!?؟]/.test(ch)){ids.push({azId:0,forceDurMs:280});i++;continue;}
        if(/[،,؛;]/.test(ch)){ids.push({azId:0,forceDurMs:130});i++;continue;}
        if(H[ch]!==undefined){ids.push({azId:H[ch]});i++;continue;}
        const az=L[ch];
        if(az!==undefined){
          ids.push({azId:az});
          if(chars[i+1]&&H[chars[i+1]]!==undefined){ids.push({azId:H[chars[i+1]]});i++;}
          i++;continue;
        }
        if(/[a-zA-Z]/.test(ch)){const m={a:1,e:4,i:6,o:3,u:7,b:21,m:21,p:21,n:19,t:19,d:19,k:20,g:20,s:15,r:13,l:14,h:12,w:3};ids.push({azId:m[ch.toLowerCase()]??0});}
        i++;
      }
      return ids;
    };
  })();

  const bengaliG2P = (function(){
    const V={'অ':1,'আ':1,'ই':6,'ঈ':6,'উ':7,'ঊ':7,'এ':4,'ও':3,'ঔ':9};
    const M={'া':1,'ি':6,'ী':6,'ু':7,'ূ':7,'ে':4,'ো':3,'ৌ':9,'ং':21};
    const C={'ক':20,'খ':20,'গ':20,'ঘ':20,'চ':16,'জ':16,'ট':19,'ড':19,'ত':19,'থ':17,
      'দ':19,'ন':19,'প':21,'ফ':18,'ব':21,'ভ':21,'ম':21,'য':4,'র':13,'ল':14,'শ':16,'স':15,'হ':12};
    return function(text){
      const ids=[],chars=[...text];let i=0;
      while(i<chars.length){
        const ch=chars[i];
        if(/\s/.test(ch)){ids.push({azId:0,forceDurMs:130});i++;continue;}
        if(/[।!?]/.test(ch)){ids.push({azId:0,forceDurMs:280});i++;continue;}
        if(V[ch]!==undefined){ids.push({azId:V[ch]});i++;continue;}
        const caz=C[ch];
        if(caz!==undefined){
          ids.push({azId:caz});
          const next=chars[i+1];
          if(next==='\u09CD'){i+=2;continue;}
          if(next&&M[next]!==undefined){ids.push({azId:M[next]});i+=2;}
          else{ids.push({azId:1});i++;}
          continue;
        }
        i++;
      }
      return ids;
    };
  })();

  const cyrillicG2P = (function(){
    const C={'а':1,'я':1,'о':3,'ё':3,'э':4,'е':4,'и':6,'й':4,'ы':6,'у':7,'ю':7,
      'м':21,'б':21,'п':21,'в':18,'ф':18,'н':19,'т':19,'д':19,'л':14,'р':13,
      'з':15,'с':15,'ж':16,'ш':16,'ч':16,'щ':16,'ц':15,'к':20,'г':20,'х':12,'ъ':0,'ь':0};
    return function(text){
      const ids=[];
      for(const ch of text.toLowerCase()){
        if(/\s/.test(ch)){ids.push({azId:0,forceDurMs:130});continue;}
        if(/[.!?…]/.test(ch)){ids.push({azId:0,forceDurMs:280});continue;}
        const az=C[ch];
        if(az!==undefined){ids.push({azId:az});continue;}
        if(/[a-z]/.test(ch)){const m={a:1,e:4,i:6,o:3,u:7,b:21,m:21,p:21,n:19,t:19,d:19,k:20,g:20,s:15,r:13,l:14,h:12,f:18,v:18};ids.push({azId:m[ch]??0});}
      }
      return ids;
    };
  })();

  const japaneseG2P = (function(){
    const H={'あ':[0,1],'い':[0,6],'う':[0,7],'え':[0,4],'お':[0,3],
      'か':[20,1],'き':[20,6],'く':[20,7],'け':[20,4],'こ':[20,3],
      'さ':[15,1],'し':[16,6],'す':[15,7],'せ':[15,4],'そ':[15,3],
      'た':[19,1],'ち':[16,6],'つ':[15,7],'て':[19,4],'と':[19,3],
      'な':[19,1],'に':[19,6],'ぬ':[19,7],'ね':[19,4],'の':[19,3],
      'は':[12,1],'ひ':[12,6],'ふ':[18,7],'へ':[12,4],'ほ':[12,3],
      'ま':[21,1],'み':[21,6],'む':[21,7],'め':[21,4],'も':[21,3],
      'や':[4,1],'ゆ':[0,7],'よ':[4,3],'ら':[13,1],'り':[13,6],'る':[13,7],'れ':[13,4],'ろ':[13,3],
      'わ':[3,1],'を':[3,3],'ん':[19,0],'が':[20,1],'ぎ':[20,6],'ぐ':[20,7],'げ':[20,4],'ご':[20,3],
      'ざ':[15,1],'じ':[16,6],'ず':[15,7],'ぜ':[15,4],'ぞ':[15,3],
      'だ':[19,1],'で':[19,4],'ど':[19,3],'ば':[21,1],'び':[21,6],'ぶ':[21,7],'べ':[21,4],'ぼ':[21,3],
      'ぱ':[21,1],'ぴ':[21,6],'ぷ':[21,7],'ぺ':[21,4],'ぽ':[21,3]};
    return function(text){
      const ids=[],chars=[...text];
      for(const ch of chars){
        const cp=ch.codePointAt(0);
        if(/\s/.test(ch)){ids.push({azId:0,forceDurMs:130});continue;}
        if(/[。！？]/.test(ch)){ids.push({azId:0,forceDurMs:280});continue;}
        const hira=cp>=0x30A0&&cp<=0x30FF?String.fromCodePoint(cp-0x60):ch;
        const mora=H[hira];
        if(mora){const[c,v]=mora;if(c)ids.push({azId:c});if(v)ids.push({azId:v});continue;}
        if(cp>=0x4E00&&cp<=0x9FFF){ids.push({azId:1});continue;}
        if(/[a-zA-Z]/.test(ch)){const m={a:1,e:4,i:6,o:3,u:7,k:20,s:15,t:19,n:19,m:21,r:13,h:12,y:4,w:3};ids.push({azId:m[ch.toLowerCase()]??0});}
      }
      return ids;
    };
  })();

  const chineseG2P = (function(){
    const Z={'的':[0,4],'一':[0,6],'是':[15,6],'在':[15,1],'了':[14,1],'有':[0,9],'我':[0,3],
      '他':[19,1],'你':[19,6],'不':[21,7],'这':[16,4],'个':[20,4],'们':[21,4],'来':[14,1],
      '说':[15,3],'大':[19,1],'为':[3,4],'和':[12,4],'国':[20,7],'好':[12,1],'对':[19,4]};
    return function(text){
      const ids=[],chars=[...text];
      for(const ch of chars){
        const cp=ch.codePointAt(0);
        if(/\s/.test(ch)){ids.push({azId:0,forceDurMs:130});continue;}
        if(/[。！？…]/.test(ch)){ids.push({azId:0,forceDurMs:280});continue;}
        if(/[，、；：]/.test(ch)){ids.push({azId:0,forceDurMs:130});continue;}
        if(cp>=0x4E00&&cp<=0x9FFF){
          const p=Z[ch];
          if(p){const[c,v]=p;if(c)ids.push({azId:c});ids.push({azId:v});}
          else ids.push({azId:1});
          continue;
        }
        if(/[a-zA-Z]/.test(ch)){const m={a:1,e:4,i:6,o:3,u:7,b:21,m:21,p:21,n:19,t:19,d:19,k:20,g:20,s:15,r:13,l:14,h:12,w:3,y:4};ids.push({azId:m[ch.toLowerCase()]??0});}
      }
      return ids;
    };
  })();

  const latinG2P = (function(){
    const MAPS={
      spanish:{a:1,á:1,e:4,é:4,i:6,í:6,o:3,ó:3,u:7,ú:7,b:21,p:21,m:21,f:18,t:19,d:19,n:19,l:14,r:13,c:20,k:20,g:20,s:15,z:15,h:0,j:12,ñ:19,v:21},
      french: {a:1,à:1,â:1,e:4,é:4,è:4,ê:4,i:6,î:6,o:3,ô:3,u:7,û:7,b:21,p:21,m:21,f:18,v:18,t:19,d:19,n:19,l:14,r:13,c:20,k:20,g:20,s:15,z:15,j:16,h:0},
      german: {a:1,ä:4,e:4,i:6,o:3,ö:4,u:7,ü:7,b:21,p:21,m:21,f:18,v:18,w:18,t:19,d:19,n:19,l:14,r:13,k:20,g:20,s:15,z:15,h:12,j:4},
      portuguese:{a:1,ã:1,â:1,á:1,e:4,é:4,ê:4,i:6,o:3,ó:3,ô:3,u:7,b:21,p:21,m:21,f:18,v:18,t:19,d:19,n:19,l:14,r:13,c:20,s:15,z:15,h:0,j:16},
      indonesian:{a:1,e:4,i:6,o:3,u:7,b:21,p:21,m:21,f:18,v:18,t:19,d:19,n:19,l:14,r:13,k:20,g:20,s:15,h:12,j:16,c:16,w:3,y:4},
    };
    return function(text,lang){
      const map=MAPS[lang]||MAPS.spanish;
      const ids=[];
      const lower=text.toLowerCase().normalize('NFC');
      for(let i=0;i<lower.length;){
        const ch=lower[i];
        if(/\s/.test(ch)){ids.push({azId:0,forceDurMs:130});i++;continue;}
        if(/[.!?…]/.test(ch)){ids.push({azId:0,forceDurMs:280});i++;continue;}
        if(/[,;:]/.test(ch)){ids.push({azId:0,forceDurMs:130});i++;continue;}
        const c2=lower.slice(i,i+2);
        if(c2==='ng'){ids.push({azId:20});i+=2;continue;}
        if(c2==='ch'){ids.push({azId:16});i+=2;continue;}
        if(c2==='sh'){ids.push({azId:16});i+=2;continue;}
        if(c2==='th'){ids.push({azId:17});i+=2;continue;}
        if(map[ch]!==undefined){ids.push({azId:map[ch]});i++;continue;}
        const stripped=ch.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
        if(map[stripped]!==undefined){ids.push({azId:map[stripped]});i++;continue;}
        i++;
      }
      return ids;
    };
  })();

  function anyTextToAzureIds(text, pillEl) {
    const lang = detectLanguage(text);
    const CODE = {english:'EN',devanagari:'HI',arabic:'AR',japanese:'JA',
      chinese:'ZH',cyrillic:'RU',bengali:'BN',french:'FR',german:'DE',
      spanish:'ES',portuguese:'PT',indonesian:'ID'};
    if (pillEl) pillEl.textContent = CODE[lang] || 'EN';
    switch(lang){
      case 'devanagari': return devanagariG2P(text);
      case 'arabic':     return arabicG2P(text);
      case 'japanese':   return japaneseG2P(text);
      case 'chinese':    return chineseG2P(text);
      case 'cyrillic':   return cyrillicG2P(text);
      case 'bengali':    return bengaliG2P(text);
      case 'french':     return latinG2P(text,'french');
      case 'german':     return latinG2P(text,'german');
      case 'spanish':    return latinG2P(text,'spanish');
      case 'portuguese': return latinG2P(text,'portuguese');
      case 'indonesian': return latinG2P(text,'indonesian');
      default:           return null;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  ENGLISH G2P
  // ═══════════════════════════════════════════════════════
  const COMMON_WORDS = {
    the:['DH','AH'],a:['AH'],an:['AE','N'],and:['AE','N','D'],is:['IH','Z'],it:['IH','T'],
    in:['IH','N'],of:['AH','V'],to:['T','UW'],be:['B','IY'],that:['DH','AE','T'],
    he:['HH','IY'],she:['SH','IY'],we:['W','IY'],you:['Y','UW'],they:['DH','EY'],
    i:['AY'],me:['M','IY'],my:['M','AY'],his:['HH','IH','Z'],her:['HH','ER'],
    was:['W','AH','Z'],are:['AA','R'],for:['F','AO','R'],on:['AO','N'],as:['AE','Z'],
    at:['AE','T'],by:['B','AY'],from:['F','R','AH','M'],with:['W','IH','DH'],
    not:['N','AA','T'],but:['B','AH','T'],or:['AO','R'],so:['S','OW'],do:['D','UW'],
    up:['AH','P'],out:['AW','T'],if:['IH','F'],no:['N','OW'],yes:['Y','EH','S'],
    hi:['HH','AY'],hello:['HH','AH','L','OW'],how:['HH','AW'],what:['W','AH','T'],
    where:['W','EH','R'],when:['W','EH','N'],why:['W','AY'],who:['HH','UW'],
    can:['K','AE','N'],will:['W','IH','L'],would:['W','UH','D'],could:['K','UH','D'],
    should:['SH','UH','D'],have:['HH','AE','V'],had:['HH','AE','D'],has:['HH','AE','Z'],
    been:['B','IH','N'],this:['DH','IH','S'],than:['DH','AE','N'],then:['DH','EH','N'],
    now:['N','AW'],just:['JH','AH','S','T'],like:['L','AY','K'],know:['N','OW'],
    think:['TH','IH','NG','K'],come:['K','AH','M'],go:['G','OW'],see:['S','IY'],
    get:['G','EH','T'],make:['M','EY','K'],want:['W','AA','N','T'],say:['S','EY'],
    one:['W','AH','N'],two:['T','UW'],three:['TH','R','IY'],four:['F','AO','R'],
    five:['F','AY','V'],six:['S','IH','K','S'],seven:['S','EH','V','AH','N'],
    eight:['EY','T'],nine:['N','AY','N'],ten:['T','EH','N'],
  };

  function letterRulesToPhonemes(word) {
    const ph=[]; let i=0;
    while(i<word.length){
      const ch=word[i],ch2=word.slice(i,i+2),ch3=word.slice(i,i+3);
      if     (ch3==='tch'){ph.push('CH');i+=3;}
      else if(ch2==='th') {ph.push('TH');i+=2;}
      else if(ch2==='sh') {ph.push('SH');i+=2;}
      else if(ch2==='ch') {ph.push('CH');i+=2;}
      else if(ch2==='wh') {ph.push('W'); i+=2;}
      else if(ch2==='ph') {ph.push('F'); i+=2;}
      else if(ch2==='ng') {ph.push('NG');i+=2;}
      else if(ch2==='ck') {ph.push('K'); i+=2;}
      else if(ch2==='ee') {ph.push('IY');i+=2;}
      else if(ch2==='ea') {ph.push('IY');i+=2;}
      else if(ch2==='oo') {ph.push('UW');i+=2;}
      else if(ch2==='ou') {ph.push('AW');i+=2;}
      else if(ch2==='ow') {ph.push('OW');i+=2;}
      else if(ch2==='oi') {ph.push('OY');i+=2;}
      else if(ch2==='oy') {ph.push('OY');i+=2;}
      else if(ch2==='ai') {ph.push('EY');i+=2;}
      else if(ch2==='ay') {ph.push('EY');i+=2;}
      else if(ch2==='au') {ph.push('AO');i+=2;}
      else if(ch2==='aw') {ph.push('AO');i+=2;}
      else if(ch2==='ew') {ph.push('UW');i+=2;}
      else if(ch==='a')   {ph.push('AE');i++;}
      else if(ch==='e')   {ph.push('EH');i++;}
      else if(ch==='i')   {ph.push('IH');i++;}
      else if(ch==='o')   {ph.push('OW');i++;}
      else if(ch==='u')   {ph.push('AH');i++;}
      else if(ch==='y')   {ph.push(i===0?'Y':'IY');i++;}
      else{const m={b:'B',c:'K',d:'D',f:'F',g:'G',h:'HH',j:'JH',k:'K',l:'L',m:'M',
                    n:'N',p:'P',q:'K',r:'R',s:'S',t:'T',v:'V',w:'W',z:'Z'};
           if(m[ch]){ph.push(m[ch]);}else if(ch==='x'){ph.push('K','S');}
           i++;}
    }
    return ph;
  }

  function textToPhonemes(text) {
    const result=[];
    const lower=text.toLowerCase().replace(/[^a-z\s.,!?'-]/g,'');
    const words=lower.split(/\s+/).filter(Boolean);
    for(let wi=0;wi<words.length;wi++){
      const word=words[wi].replace(/[.,!?'-]/g,'');
      if(!word) continue;
      const ph=COMMON_WORDS[word];
      if(ph) result.push(...ph); else result.push(...letterRulesToPhonemes(word));
      const punct=words[wi].slice(-1);
      if('.!?'.includes(punct)) result.push('PAU','PAU');
      else result.push('SP');
    }
    return result;
  }

  function phonemesToSchedule(phonemes) {
    const entries=[]; let cursor=0;
    for(let i=0;i<phonemes.length;i++){
      const ph=phonemes[i], azId=PHONEME_TO_AZ[ph]??0;
      let dur;
      if(ph==='PAU') dur=PUNCT_PAUSE_MS;
      else if(ph==='SP') dur=SILENCE_PAUSE_MS;
      else{ const imp=AZ_IMPORTANCE[azId]||0.3; dur=Math.round(80+imp*100); }
      dur=Math.max(MIN_PHONEME_MS,Math.min(MAX_PHONEME_MS,dur));
      if(entries.length>0&&entries[entries.length-1].azId===azId){
        entries[entries.length-1].durationMs+=dur; cursor+=dur; continue;
      }
      const blendWith={};
      if(entries.length>0){ const prevId=entries[entries.length-1].azId; blendWith[prevId]=40; }
      if(i+1<phonemes.length){
        const nextId=PHONEME_TO_AZ[phonemes[i+1]]??0;
        if(nextId!==azId&&nextId!==0) blendWith[nextId]=25;
      }
      entries.push({azId,startMs:cursor,durationMs:dur,blendWith});
      cursor+=dur;
    }
    return entries;
  }

  // ═══════════════════════════════════════════════════════
  //  AUDIO HELPERS
  // ═══════════════════════════════════════════════════════
  function base64ToInt16(b64){
    const bin=atob(b64),bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }
  function float32ToInt16(f32){
    const i16=new Int16Array(f32.length);
    for(let i=0;i<f32.length;i++){const s=Math.max(-1,Math.min(1,f32[i]));i16[i]=s<0?s*32768:s*32767;}
    return i16;
  }
  function int16ToBase64(i16){
    const bytes=new Uint8Array(i16.buffer);
    let b='';for(const byte of bytes) b+=String.fromCharCode(byte);
    return btoa(b);
  }

  // ═══════════════════════════════════════════════════════
  //  CHARACTER BEHAVIOR CONTROLLER
  //  Expression/idle animation layer. Runs alongside lip-sync.
  //  Drives blink, eye dart, head, breathing, emotions via Rive.
  //
  //  Input name defaults (override via opts.inputMap or named opts):
  //    Blink, EyeX, EyeY, HeadTilt, HeadNod, Breathe, Smile, BrowRaise
  //
  //  How to add a gesture:
  //    1. Map a key in opts.inputMap.
  //    2. Call _setNumber(key, value) or _fireTrigger(key).
  //    3. Wrap in _canGesture() + _markGesture(cooldownMs).
  // ═══════════════════════════════════════════════════════
  class CharacterBehaviorController {
    constructor(inputs, opts = {}) {
      this._inputs = inputs || {};
      this._map = {
        blink: 'Blink', eyeX: 'EyeX', eyeY: 'EyeY',
        headTilt: 'HeadTilt', headNod: 'HeadNod', breathe: 'Breathe',
        smile: 'Smile', brows: 'BrowRaise',
        ...(opts.inputMap || {}),
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

    start() {
      if (this._running) return;
      this._running = true;
      this._lastMs = performance.now();
      this._nextBlinkMs = performance.now() + this._blinkInterval();
      this._nextDartMs  = performance.now() + 3000 + Math.random() * 4000;
      this._tick();
    }

    stop() {
      this._running = false;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    }

    setState(state) {
      this._state = state;
    }

    reactToEmotion(text) {
      if (!text) return;
      const t = text.toLowerCase();
      if (/\b(wow|incredible|really|oh my|fascinating|remarkable)\b/.test(t)) { this._triggerBrows(); return; }
      if (/\b(great|excellent|wonderful|amazing|love|thanks|glad|happy|awesome|perfect)\b/.test(t)) { this._triggerSmile(); return; }
      if (/\b(sorry|unfortunately|problem|issue|error|fail|mistake|wrong|trouble)\b/.test(t)) { this._triggerEmpathy(); }
      if (/\?/.test(text)) { this._triggerThinkingLook(); }
    }

    _tick() {
      if (!this._running) return;
      const now = performance.now();
      const dt  = Math.min(now - this._lastMs, 100);
      this._lastMs = now;
      this._updateBreathe(dt);
      this._updateBlink(now);
      this._updateEyeDart(now);
      this._updateIdleHead(dt);
      if (this._state === 'listening') this._applyListeningPose(now);
      if (this._state === 'thinking')  this._applyThinkingPose(now);
      this._raf = requestAnimationFrame(() => this._tick());
    }

    _updateBreathe(dt) {
      if (this._state !== 'idle' && this._state !== 'listening') return;
      this._breathPhase += dt * 0.0028;
      this._setNumber('breathe', (Math.sin(this._breathPhase) * 0.5 + 0.5) * 30 * this._idleIntensity);
    }

    _updateBlink(now) {
      if (now < this._nextBlinkMs) return;
      this._fireTrigger('blink');
      if (Math.random() < 0.12) setTimeout(() => this._fireTrigger('blink'), 180);
      this._nextBlinkMs = now + this._blinkInterval();
    }

    _blinkInterval() { return (this._state === 'idle' ? 3000 : 4500) + Math.random() * 3000; }

    _updateEyeDart(now) {
      if (this._state === 'thinking') return;
      if (now < this._nextDartMs) return;
      const x = (Math.random() - 0.5) * 22, y = (Math.random() - 0.5) * 12;
      this._setNumber('eyeX', x * this._idleIntensity);
      this._setNumber('eyeY', y * this._idleIntensity);
      setTimeout(() => { this._setNumber('eyeX', 0); this._setNumber('eyeY', 0); }, 380 + Math.random() * 250);
      this._nextDartMs = now + 3000 + Math.random() * 5000;
    }

    _updateIdleHead(dt) {
      if (this._state !== 'idle') return;
      this._idleNoisePhase += dt * 0.0009;
      this._setNumber('headTilt', Math.sin(this._idleNoisePhase * 0.7) * 5  * this._idleIntensity);
      this._setNumber('headNod',  Math.sin(this._idleNoisePhase * 0.5) * 3  * this._idleIntensity);
    }

    _applyListeningPose(now) {
      this._setNumber('headTilt', (Math.sin(now * 0.0006) * 2 + 4) * this._idleIntensity);
    }

    _applyThinkingPose(now) {
      const d = Math.sin(now * 0.0009) * 4;
      this._setNumber('eyeX', 14 + d);
      this._setNumber('eyeY', -16 + d * 0.5);
    }

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

    _triggerThinkingLook() {
      if (!this._canGesture()) return;
      this._setNumber('eyeX', 18 * this._gestureIntensity);
      this._setNumber('eyeY', -13 * this._gestureIntensity);
      setTimeout(() => { this._setNumber('eyeX', 0); this._setNumber('eyeY', 0); }, 700);
      this._markGesture(1200);
    }

    _canGesture()            { return performance.now() >= this._gestureCooldownMs; }
    _markGesture(cooldownMs) { this._gestureCooldownMs = performance.now() + cooldownMs; }

    _setNumber(key, value) {
      const inp = this._inputs[this._map[key]];
      if (!inp) return;
      if (typeof inp.fire === 'function' && typeof inp.value === 'undefined') return;
      inp.value = Math.max(-100, Math.min(100, value));
    }

    _fireTrigger(key) {
      const inp = this._inputs[this._map[key]];
      if (!inp) return;
      if (typeof inp.fire === 'function') inp.fire();
      else if ('value' in inp) inp.value = true;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  LIPSYNCAVATAR CLASS
  // ═══════════════════════════════════════════════════════
  class LipsyncAvatar {
    /**
     * @param {object} opts
     * @param {string|HTMLElement} opts.container   - CSS selector or element to inject widget into
     * @param {string}             opts.riveSrc      - Path/URL to your .riv file
     * @param {string}             opts.apiKey       - Gemini API key
     * @param {string}             [opts.model]      - Gemini model (default: gemini-3.1-flash-live-preview)
     * @param {string}             [opts.voice]      - Initial voice name (default: 'Puck')
     * @param {string}             [opts.systemPrompt]
     * @param {string}             [opts.knowledgeBase] - Owner-provided context (FAQ, docs, product info). Injected into the system prompt so the model answers from this content.
     * @param {number}             [opts.width]      - Canvas width in px (default: 300)
     * @param {number}             [opts.height]     - Canvas height in px (default: 300)
     * @param {string}             [opts.theme]      - 'dark' | 'light' (default: 'dark')
     * @param {boolean}            [opts.showVoiceSelect] - Show voice dropdown (default: true)
     * @param {boolean}            [opts.showTranscript]  - Show transcript panel (default: true)
     * @param {boolean}            [opts.showTextInput]   - Show text input bar (default: true)
     * @param {boolean}            [opts.showBands]       - Show FFT band meter (default: true)
     * @param {string}             [opts.artboard]   - Rive artboard name (default: 'Character')
     * @param {string}             [opts.stateMachine] - Rive state machine (default: 'InLesson')
     * @param {object}             [opts.riveInputMap] - Optional override: { azVisemeId: riveInputNumber }
     * @param {string}             [opts.visemeSpeedMode] - 'timed-ramp' | 'instant' (default: 'timed-ramp')
     * @param {number}             [opts.visemeMinValue] - Minimum active mouth value, default 1
     * @param {number}             [opts.visemeMaxValue] - Maximum active mouth value, default 100
     * @param {number}             [opts.visemePeakRatio] - 0-1 point in each viseme where value reaches max, default 0.88
     * @param {number}             [opts.visemeOverlapMs] - Start the next viseme slightly early for smoother switching, default 35
     * @param {Function}           [opts.onConnected]
     * @param {Function}           [opts.onDisconnected]
     * @param {Function}           [opts.onSpeaking]
     * @param {Function}           [opts.onListening]
     * @param {Function}           [opts.onTranscript]  - (role:'user'|'model', text:string)
     * @param {Function}           [opts.onViseme]      - (azId:number, label:string)
     * @param {Function}           [opts.onError]       - (message:string)
     */
    constructor(opts = {}) {
      if (!opts.container) throw new Error('[LipsyncAvatar] opts.container is required');
      if (!opts.riveSrc)   throw new Error('[LipsyncAvatar] opts.riveSrc is required');
      if (!opts.apiKey)    throw new Error('[LipsyncAvatar] opts.apiKey is required');

      this._opts = Object.assign({
        model: DEFAULT_MODEL,
        voice: 'Puck',
        systemPrompt: 'You are a friendly, expressive AI assistant. Speak naturally.',
        knowledgeBase: '',
        width: 300,
        height: 300,
        theme: 'dark',
        showVoiceSelect: true,
        showTranscript: true,
        showTextInput: true,
        showBands: true,
        artboard: 'Character',
        stateMachine: 'InLesson',
        riveInputMap: null,
        visemeSpeedMode: 'timed-ramp',
        visemeMinValue: RIVE_ACTIVE_MIN_VALUE,
        visemeMaxValue: RIVE_ACTIVE_MAX_VALUE,
        visemePeakRatio: 0.88,
        visemeOverlapMs: 35,
        // Hybrid lip-sync params
        anticipationMs: 40,      // pre-roll mouth N ms before phoneme starts
        minVisemeMs: 50,         // minimum hold per viseme (prevents flutter on fast consonants)
        smoothingMs: 70,         // not used by timed-ramp but exposed for downstream controllers
        mouthDelayMs: 0,         // positive = delay anchor (audio arrives late); negative = advance
        amplitudeSensitivity: 1.0,
        // Character behavior controller
        enableBehavior: false,
        behaviorConfig: {},
      }, opts);

      this._opts.visemeMinValue = Math.max(1, Math.min(99, Number(this._opts.visemeMinValue) || RIVE_ACTIVE_MIN_VALUE));
      this._opts.visemeMaxValue = Math.max(this._opts.visemeMinValue, Math.min(100, Number(this._opts.visemeMaxValue) || RIVE_ACTIVE_MAX_VALUE));
      this._opts.visemePeakRatio = Math.max(0.1, Math.min(1, Number(this._opts.visemePeakRatio) || 0.88));
      this._opts.visemeOverlapMs = Math.max(0, Math.min(140, Number(this._opts.visemeOverlapMs) || 35));

      this._riveInputByAz = RIVE_INPUT_BY_AZ.slice();
      if (this._opts.riveInputMap && typeof this._opts.riveInputMap === 'object') {
        for (const [azId, riveInput] of Object.entries(this._opts.riveInputMap)) {
          const i = Number(azId);
          const inputNumber = Number(riveInput);
          if (Number.isInteger(i) && i >= 0 && i < VISEME_COUNT && Number.isFinite(inputNumber)) {
            this._riveInputByAz[i] = inputNumber;
          }
        }
      }

      // State
      this._voice        = this._opts.voice;
      this._ws           = null;
      this._audioCtx     = null;
      this._analyser     = null;
      this._nextPlayAt   = 0;
      this._isMicOn      = false;
      this._micProc      = null;
      this._micStream    = null;
      this._analysisInt  = null;
      this._isConnected  = false;
      this._riveInst     = null;
      this._riveInputs   = {};
      this._riveReady    = false;
      this._wTarget      = new Float32Array(VISEME_COUNT).fill(0);
      this._wCurrent     = new Float32Array(VISEME_COUNT).fill(0);
      this._lerpRaf      = null;
      this._currentAzId  = 0;
      this._schedQueue   = [];
      this._schedRaf     = null;
      this._audioStart   = 0;
      this._fftBands     = {};
      this._silenceHoldMs       = 0;
      this._destroyed           = false;
      this._outputTranscriptBuf = '';
      this._inputTranscriptBuf  = '';
      this._outputMsgEl         = null;
      this._behaviorCtrl        = null;

      // Defer UI build until DOM is parsed. This prevents the common
      // "container not found" error when the <script> tag runs before
      // the target div has been created in the document.
      const start = () => {
        _injectStyles();
        this._buildUI();
        this._loadRive();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
      } else {
        start();
      }
    }

    // ─────────────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────────────

    /** Connect to Gemini Live and start a session */
    connect() {
      if (this._isConnected || this._destroyed) return;
      this._startSession();
    }

    /** Disconnect the current session */
    disconnect() {
      if (!this._isConnected) return;
      this._stopSession();
    }

    /** Send a text message to the model */
    sendText(text) {
      if (!text || !this._isConnected || !this._ws) return;
      this._ws.send(JSON.stringify({ realtime_input: { text } }));
      this._addMsg(text, 'user');
      this._fire('onTranscript', 'user', text);
    }

    /** Start microphone capture (hold-to-speak) */
    async startMic() {
      if (!this._isConnected || this._isMicOn) return;
      await this._startMicCapture();
    }

    /** Stop microphone capture */
    stopMic() {
      this._stopMicNow();
    }

    /** Change voice (only takes effect before connecting) */
    setVoice(voiceName) {
      this._voice = voiceName;
      if (this._el.voiceSelect) this._el.voiceSelect.value = voiceName;
    }

    /** Get list of available voices */
    static get voices() { return VOICES; }

    /** Default video-matched map: Azure viseme id -> Rive input number */
    static get defaultRiveInputMap() { return RIVE_INPUT_BY_AZ.slice(); }

    /** Destroy the widget and free all resources */
    destroy() {
      this._destroyed = true;
      this._stopSession();
      if (this._lerpRaf) { cancelAnimationFrame(this._lerpRaf); this._lerpRaf = null; }
      if (this._schedRaf) { cancelAnimationFrame(this._schedRaf); this._schedRaf = null; }
      if (this._riveInst) { try { this._riveInst.cleanup(); } catch(_) {} }
      if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    }

    /**
     * Build the final system prompt by combining the base persona with
     * owner-supplied knowledge base content. Called every time a session
     * starts, so updates to `knowledgeBase` between sessions take effect.
     */
    _buildSystemPrompt() {
      const base = this._opts.systemPrompt || '';
      const kb   = (this._opts.knowledgeBase || '').trim();
      if (!kb) return base;
      return `${base}

You have been provided with the following knowledge base by the website owner. Answer the user's questions using ONLY this information whenever possible. If a question cannot be answered from this knowledge base, politely say you don't have that information rather than guessing.

=== KNOWLEDGE BASE ===
${kb}
=== END KNOWLEDGE BASE ===

When answering, speak naturally and conversationally — do not read the knowledge base verbatim. Stay strictly within the scope of this content.`;
    }

    /** Update the knowledge base at runtime (takes effect on next connect) */
    setKnowledgeBase(text) {
      this._opts.knowledgeBase = text || '';
    }

    // ─────────────────────────────────────────────────────
    //  UI BUILDER
    // ─────────────────────────────────────────────────────
    _buildUI() {
      const o = this._opts;
      const container = typeof o.container === 'string'
        ? document.querySelector(o.container)
        : o.container;
      if (!container) throw new Error(`[LipsyncAvatar] container not found: ${o.container}`);

      this._root = document.createElement('div');
      this._root.className = `lsa-root lsa-theme-${o.theme}`;

      // ── Header: status + viseme pill + lang pill
      const header = document.createElement('div');
      header.className = 'lsa-header';

      const dot = document.createElement('div');
      dot.className = 'lsa-status-dot';

      const statusLabel = document.createElement('span');
      statusLabel.className = 'lsa-status-label';
      statusLabel.textContent = 'Disconnected';

      const visemePill = document.createElement('div');
      visemePill.className = 'lsa-viseme-pill';
      visemePill.textContent = 'sil · 100';

      const langPill = document.createElement('div');
      langPill.className = 'lsa-lang-pill';
      langPill.textContent = 'EN';

      header.append(dot, statusLabel, visemePill, langPill);

      // ── Canvas
      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'lsa-canvas-wrap';
      canvasWrap.style.width  = o.width  + 'px';
      canvasWrap.style.height = o.height + 'px';

      const canvas = document.createElement('canvas');
      canvas.className = 'lsa-canvas';
      canvas.width  = 600;
      canvas.height = 600;

      const placeholder = document.createElement('div');
      placeholder.className = 'lsa-placeholder';
      placeholder.innerHTML = `
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.3">
          <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
        </svg>
        <span>Loading character…</span>`;

      canvasWrap.append(canvas, placeholder);

      // ── FFT Bands
      const bandColors = ['#534ab7','#1d9e75','#d85a30','#185fa5','#639922'];
      const bands = document.createElement('div');
      bands.className = 'lsa-bands';
      bands.style.width = o.width + 'px';
      const bandEls = [];
      if (o.showBands) {
        bandColors.forEach((color, i) => {
          const b = document.createElement('div');
          b.className = 'lsa-band';
          b.style.background = color;
          b.style.height = '2px';
          bands.appendChild(b);
          bandEls.push(b);
        });
      }

      // ── Controls
      const controls = document.createElement('div');
      controls.className = 'lsa-controls';
      controls.style.width = o.width + 'px';

      // Voice select
      let voiceSelect = null;
      if (o.showVoiceSelect) {
        const voiceWrap = document.createElement('div');
        voiceWrap.className = 'lsa-voice-wrap';
        const icon = document.createElement('span');
        icon.textContent = '🎙';
        voiceSelect = document.createElement('select');
        voiceSelect.className = 'lsa-voice-select';
        VOICES.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.n;
          opt.textContent = `${v.n} · ${v.s} (${v.g})`;
          if (v.n === this._voice) opt.selected = true;
          voiceSelect.appendChild(opt);
        });
        voiceSelect.addEventListener('change', () => {
          if (this._isConnected) { voiceSelect.value = this._voice; return; }
          this._voice = voiceSelect.value;
        });
        voiceWrap.append(icon, voiceSelect);
        controls.appendChild(voiceWrap);
      }

      // Connect + Mic buttons
      const btnRow = document.createElement('div');
      btnRow.className = 'lsa-row';

      const btnConnect = document.createElement('button');
      btnConnect.className = 'lsa-btn lsa-btn-connect';
      btnConnect.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
        </svg> Start session`;
      btnConnect.addEventListener('click', () => {
        if (this._isConnected) this.disconnect(); else this.connect();
      });

      const btnMic = document.createElement('button');
      btnMic.className = 'lsa-btn lsa-btn-mic';
      btnMic.disabled = true;
      btnMic.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="2" width="6" height="12" rx="3"/>
          <path d="M5 10a7 7 0 0 0 14 0M12 19v3M8 22h8"/>
        </svg> Hold to speak`;

      btnMic.addEventListener('mousedown',  () => this.startMic());
      btnMic.addEventListener('mouseup',    () => this.stopMic());
      btnMic.addEventListener('mouseleave', () => this.stopMic());
      btnMic.addEventListener('touchstart', (e) => { e.preventDefault(); this.startMic(); });
      btnMic.addEventListener('touchend',   () => this.stopMic());

      btnRow.append(btnConnect, btnMic);
      controls.appendChild(btnRow);

      // Text input
      let textInput = null, btnSend = null;
      if (o.showTextInput) {
        const inputRow = document.createElement('div');
        inputRow.className = 'lsa-input-row';

        textInput = document.createElement('input');
        textInput.className = 'lsa-text-input';
        textInput.placeholder = 'Type a message…';
        textInput.disabled = true;
        textInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') this.sendText(textInput.value.trim());
        });

        btnSend = document.createElement('button');
        btnSend.className = 'lsa-btn-send';
        btnSend.disabled = true;
        btnSend.textContent = 'Send';
        btnSend.addEventListener('click', () => {
          if (textInput) this.sendText(textInput.value.trim());
          if (textInput) textInput.value = '';
        });

        inputRow.append(textInput, btnSend);
        controls.appendChild(inputRow);
      }

      // Error bar
      const errorBar = document.createElement('div');
      errorBar.className = 'lsa-error';

      // Transcript
      let transcript = null;
      if (o.showTranscript) {
        transcript = document.createElement('div');
        transcript.className = 'lsa-transcript';
        transcript.style.width = o.width + 'px';
      }

      // Assemble
      this._root.append(header, canvasWrap);
      if (o.showBands) this._root.appendChild(bands);
      this._root.append(controls, errorBar);
      if (transcript) this._root.appendChild(transcript);

      container.appendChild(this._root);

      // Store element refs
      this._el = {
        dot, statusLabel, visemePill, langPill,
        canvasWrap, canvas, placeholder,
        bandEls,
        btnConnect, btnMic,
        voiceSelect, textInput, btnSend,
        errorBar, transcript,
      };
    }

    // ─────────────────────────────────────────────────────
    //  RIVE INIT
    // ─────────────────────────────────────────────────────
    _loadRive() {
      const doInit = () => {
        if (typeof rive === 'undefined') {
          console.error('[LipsyncAvatar] rive.js not loaded. Add: <script src="https://unpkg.com/@rive-app/canvas@2.21.5/rive.js"></script>');
          return;
        }
        this._riveInst = new rive.Rive({
          src: this._opts.riveSrc,
          canvas: this._el.canvas,
          artboard: this._opts.artboard,
          stateMachines: [this._opts.stateMachine],
          autoplay: true,
          onLoad: () => {
            const inputs = this._riveInst.stateMachineInputs(this._opts.stateMachine) || [];
            let found = 0;
            for (const inp of inputs) {
              if (inp.type === rive.StateMachineInputType.Number) {
                this._riveInputs[inp.name] = inp;
                inp.value = 0;
                found++;
              }
            }
            const requiredInputs = [...new Set(this._riveInputByAz.map(String))];
            const missingInputs = requiredInputs.filter(name => !this._riveInputs[name]);
            this._riveReady = found > 0;
            this._el.placeholder.style.display = 'none';
            console.log(`[LipsyncAvatar] Rive ready — ${found} inputs`);
            if (missingInputs.length) {
              console.warn(`[LipsyncAvatar] Missing mapped Rive inputs: ${missingInputs.join(', ')}`);
            }
            this._startLerpLoop();
            this._setAzureViseme(0, { immediate: true });

            // Build behavior controller once inputs are known
            if (this._opts.enableBehavior) {
              this._behaviorCtrl = new CharacterBehaviorController(
                this._riveInputs,
                this._opts.behaviorConfig || {}
              );
              this._behaviorCtrl.start();
            }
          },
          onLoadError: (e) => {
            const span = this._el.placeholder.querySelector('span');
            if (span) span.textContent = `${this._opts.riveSrc} not found`;
            console.error('[LipsyncAvatar] Rive load error:', e);
          },
        });
      };

      if (document.readyState === 'loading') {
        window.addEventListener('load', doInit);
      } else {
        // Small defer to ensure rive.js is fully parsed
        setTimeout(doInit, 0);
      }
    }

    // ─────────────────────────────────────────────────────
    //  VISEME BLENDING
    // ─────────────────────────────────────────────────────
    _startLerpLoop() {
      if (this._lerpRaf) return;
      // Keep applying the current values every frame. The scheduler updates
      // _wCurrent with a time-based 1→100 ramp aligned to the spoken audio.
      const tick = () => {
        if (this._destroyed) return;
        this._applyVisemeTargets();
        this._lerpRaf = requestAnimationFrame(tick);
      };
      this._lerpRaf = requestAnimationFrame(tick);
    }

    _applyVisemeTargets() {
      if (!this._riveReady) return;

      // Clear every mapped mouth input first.
      const mappedInputNames = [...new Set(this._riveInputByAz.map(n => String(n)))];
      for (const inputName of mappedInputNames) {
        const inp = this._riveInputs[inputName];
        if (inp) inp.value = RIVE_INACTIVE_VALUE;
      }

      // Apply the active viseme value(s). Values are 1-100 while active.
      for (let i = 0; i < VISEME_COUNT; i++) {
        const value = this._wCurrent[i];
        if (value <= 0) continue;
        const inputName = String(this._riveInputByAz[i] ?? (100 + i));
        const inp = this._riveInputs[inputName];
        if (inp) inp.value = Math.max(0, Math.min(100, value));
      }
    }

    _timedMouthValue(progress, durationMs) {
      const minValue = this._opts.visemeMinValue;
      const maxValue = this._opts.visemeMaxValue;
      if (this._opts.visemeSpeedMode === 'instant') return maxValue;

      // Progress is normalized to the spoken viseme duration. The mouth starts
      // at 1 and reaches 100 close to the end of the viseme instead of jumping.
      const peakRatio = this._opts.visemePeakRatio;
      const normalized = clamp01(progress / peakRatio);
      const eased = durationMs < 80 ? easeOutCubic(normalized) : easeInOutCubic(normalized);
      return Math.round(minValue + (maxValue - minValue) * eased);
    }

    /**
     * Set exact Rive values per Azure-style viseme id.
     * values: { azId: 0-100, ... }
     */
    _setVisemeWeights(values, opts = {}) {
      this._wTarget.fill(RIVE_INACTIVE_VALUE);
      this._wCurrent.fill(RIVE_INACTIVE_VALUE);

      let domId = 0, domW = -Infinity;
      for (const [id, value] of Object.entries(values || {})) {
        const i = Number(id);
        const v = Math.max(0, Math.min(100, Number(value) || 0));
        if (i >= 0 && i < VISEME_COUNT && v > 0) {
          this._wTarget[i] = v;
          this._wCurrent[i] = v;
          if (v > domW) { domW = v; domId = i; }
        }
      }

      if (domW === -Infinity) {
        domId = 0;
        const v = opts.immediate ? this._opts.visemeMaxValue : this._opts.visemeMinValue;
        this._wTarget[0] = v;
        this._wCurrent[0] = v;
      }

      this._applyVisemeTargets();
      this._updateVisemePill(domId);
    }

    _updateVisemePill(domId) {
      const changed = domId !== this._currentAzId;
      this._currentAzId = domId;
      const color = AZ_COLOR[domId] || '#888';
      const inputNumber = this._riveInputByAz[domId] ?? (100 + domId);
      const inputLabel = RIVE_INPUT_LABEL[inputNumber] || AZ_LABEL[domId] || '?';
      const value = Math.round(this._wCurrent[domId] || 0);
      this._el.visemePill.textContent       = `${AZ_LABEL[domId]||'?'} · ${inputNumber} · ${value}`;
      this._el.visemePill.title             = `Rive input ${inputNumber}: ${inputLabel}, value ${value}`;
      this._el.visemePill.style.color       = color;
      this._el.visemePill.style.borderColor = color + '55';
      if (changed) this._fire('onViseme', domId, AZ_LABEL[domId] || '?');
    }

    _setAzureViseme(id, opts = {}) {
      // Direct rest/silence calls close the mouth fully. Scheduled silence still
      // ramps 1→100 inside _driveSchedule when a pause is part of speech timing.
      const value = (opts.immediate || id === 0)
        ? this._opts.visemeMaxValue
        : this._opts.visemeMinValue;
      this._setVisemeWeights({ [id]: value }, opts);
    }

    // ─────────────────────────────────────────────────────
    //  PHONEME SCHEDULER
    // ─────────────────────────────────────────────────────
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

    _driveSchedule() {
      if (!this._audioCtx || this._audioStart <= 0) {
        this._schedRaf = null; return;
      }

      const nowMs = (this._audioCtx.currentTime - this._audioStart) * 1000;
      while (this._schedQueue.length > 0 && this._schedQueue[0].endMs < nowMs) {
        this._schedQueue.shift();
      }

      if (this._schedQueue.length > 0) {
        const curr = this._schedQueue[0];
        const next = this._schedQueue[1] || null;
        const values = {};

        if (nowMs >= curr.startMs) {
          const currProgress = clamp01((nowMs - curr.startMs) / Math.max(1, curr.durationMs));
          values[curr.azId] = this._timedMouthValue(currProgress, curr.durationMs);

          // Start the next viseme a little early at a small value. This removes
          // the hard cut between mouth shapes without forcing every input to 100.
          if (next && this._opts.visemeSpeedMode !== 'instant') {
            const overlapMs = Math.min(this._opts.visemeOverlapMs, Math.max(0, curr.durationMs * 0.45));
            const overlapStart = curr.endMs - overlapMs;
            if (overlapMs > 0 && nowMs >= overlapStart && next.azId !== curr.azId) {
              const nextProgress = clamp01((nowMs - overlapStart) / overlapMs);
              values[next.azId] = Math.max(
                this._opts.visemeMinValue,
                Math.round(this._opts.visemeMinValue + (this._opts.visemeMaxValue * 0.28) * easeOutCubic(nextProgress))
              );
            }
          }

          this._setVisemeWeights(values);
        }
      } else {
        // Queue empty — drive jaw from amplitude when audio is still audible.
        // This covers the gap between first audio chunk and first transcript arriving.
        const vol = Object.values(this._fftBands).reduce((a, b) => a + b, 0) / 5;
        const ampSens = this._opts.amplitudeSensitivity || 1.0;
        const audioIsPlaying = this._audioStart > 0 &&
          this._audioCtx && this._audioCtx.currentTime < this._nextPlayAt + 0.1;
        if (vol > 0.0002 && audioIsPlaying) {
          const jawAmp = clamp01(vol / 0.014 * ampSens);
          const jawValue = Math.round(
            this._opts.visemeMinValue +
            (this._opts.visemeMaxValue - this._opts.visemeMinValue) * jawAmp
          );
          if (jawValue > this._opts.visemeMinValue) {
            this._setVisemeWeights({ 1: jawValue }); // az viseme 1 = aa (wide open)
          } else {
            this._setAzureViseme(0);
          }
        } else {
          this._setAzureViseme(0);
        }
      }

      this._schedRaf = requestAnimationFrame(() => this._driveSchedule());
    }

    // ─────────────────────────────────────────────────────
    //  SESSION
    // ─────────────────────────────────────────────────────
    _startSession() {
      if (this._audioCtx) {
        this._audioCtx.resume();
      } else {
        this._audioCtx  = new AudioContext({ sampleRate: OUT_RATE });
        this._analyser  = this._audioCtx.createAnalyser();
        this._analyser.fftSize = FFT_SIZE;
        this._analyser.smoothingTimeConstant = 0;
        this._analyser.connect(this._audioCtx.destination);
      }

      this._audioStart  = 0;
      this._nextPlayAt  = 0;
      this._schedQueue  = [];
      this._schedRaf    = null;

      const url = new URL(`wss://${WS_HOST}${WS_PATH}`);
      url.searchParams.set('key', this._opts.apiKey.trim());

      this._setStatus('Connecting…', '');
      this._el.btnConnect.disabled = true;

      const ws = new WebSocket(url.toString());
      this._ws = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          setup: {
            model: `models/${this._opts.model}`,
            generation_config: {
              response_modalities: ['AUDIO'],
              speech_config: {
                voice_config: { prebuilt_voice_config: { voice_name: this._voice } },
              },
            },
            output_audio_transcription: {},
            input_audio_transcription:  {},
            system_instruction: {
              parts: [{ text: this._buildSystemPrompt() }],
            },
          },
        }));
      };

      ws.onmessage = async (e) => {
        let jsonStr;
        if      (typeof e.data === 'string')   jsonStr = e.data;
        else if (e.data instanceof Blob)        jsonStr = await e.data.text();
        else if (e.data instanceof ArrayBuffer) jsonStr = new TextDecoder().decode(e.data);
        else return;

        let msg;
        try { msg = JSON.parse(jsonStr); } catch { return; }

        if (msg.setupComplete !== undefined) {
          this._isConnected = true;
          this._setStatus('Listening…', 'connected');
          this._el.btnConnect.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg> End session`;
          this._el.btnConnect.classList.add('lsa-active');
          this._el.btnConnect.disabled = false;
          this._el.btnMic.disabled = false;
          if (this._el.textInput) this._el.textInput.disabled = false;
          if (this._el.btnSend)   this._el.btnSend.disabled   = false;
          if (this._el.voiceSelect) this._el.voiceSelect.disabled = true;
          this._startFFT();
          this._addMsg('Session started', 'system');
          if (this._behaviorCtrl) this._behaviorCtrl.setState('idle');
          this._fire('onConnected');
          return;
        }

        const content = msg?.serverContent;
        if (!content) return;

        if (content.modelTurn?.parts) {
          for (const part of content.modelTurn.parts) {
            if (part.inlineData?.data) {
              this._playPCM(base64ToInt16(part.inlineData.data));
              this._setStatus('Speaking…', 'speaking');
              this._el.canvasWrap.classList.add('lsa-speaking');
              this._el.canvasWrap.classList.remove('lsa-listening');
              if (this._behaviorCtrl) this._behaviorCtrl.setState('speaking');
              this._fire('onSpeaking');
            }
            if (part.text) this._addMsg(part.text, 'model');
          }
        }

        if (content.outputTranscription?.text) {
          const delta = content.outputTranscription.text;
          this._outputTranscriptBuf += delta;
          // Schedule visemes from the delta only (cumulative would re-queue duplicates)
          this._scheduleFromText(delta);
          if (this._behaviorCtrl) this._behaviorCtrl.reactToEmotion(delta);
          // Update SDK's internal transcript display with the full accumulated text
          if (this._el.transcript) {
            if (!this._outputMsgEl) {
              this._outputMsgEl = document.createElement('div');
              this._outputMsgEl.className = 'lsa-msg model';
              this._el.transcript.appendChild(this._outputMsgEl);
            }
            this._outputMsgEl.textContent = this._outputTranscriptBuf;
            this._el.transcript.scrollTop = this._el.transcript.scrollHeight;
          }
          // Fire cumulative text so callers can replace (not append) their bubble
          this._fire('onTranscript', 'model', this._outputTranscriptBuf);
        }

        if (content.inputTranscription?.text) {
          const delta = content.inputTranscription.text;
          this._inputTranscriptBuf += delta;
          this._fire('onTranscript', 'user', this._inputTranscriptBuf);
        }

        if (content.turnComplete) {
          this._setStatus('Listening…', 'connected');
          this._el.canvasWrap.className = 'lsa-canvas-wrap';
          this._outputTranscriptBuf = '';
          this._inputTranscriptBuf  = '';
          this._outputMsgEl         = null;
          if (this._behaviorCtrl) this._behaviorCtrl.setState('listening');
          setTimeout(() => {
            this._schedQueue = [];
            this._audioStart = 0;
            this._setAzureViseme(0, { immediate: true });
            if (this._behaviorCtrl) this._behaviorCtrl.setState('idle');
          }, 400);
        }

        if (content.interrupted) {
          this._nextPlayAt = this._audioCtx.currentTime;
          this._schedQueue = [];
          this._audioStart  = 0;
          this._setAzureViseme(0, { immediate: true });
          this._setStatus('Interrupted', 'listening');
          this._el.canvasWrap.classList.add('lsa-listening');
          this._el.canvasWrap.classList.remove('lsa-speaking');
          this._outputTranscriptBuf = '';
          this._inputTranscriptBuf  = '';
          this._outputMsgEl         = null;
          if (this._behaviorCtrl) this._behaviorCtrl.setState('listening');
        }
      };

      ws.onerror = () => {
        this._showError('WebSocket error — check API key and network');
        this._setStatus('Error', 'error');
        this._el.btnConnect.disabled = false;
        this._fire('onError', 'WebSocket error — check API key and network');
      };

      ws.onclose = () => {
        this._isConnected = false;
        this._schedQueue  = [];
        this._setStatus('Disconnected', '');
        this._el.btnConnect.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
          </svg> Start session`;
        this._el.btnConnect.classList.remove('lsa-active');
        this._el.btnConnect.disabled = false;
        this._el.btnMic.disabled = true;
        if (this._el.textInput) this._el.textInput.disabled = true;
        if (this._el.btnSend)   this._el.btnSend.disabled   = true;
        if (this._el.voiceSelect) this._el.voiceSelect.disabled = false;
        this._el.canvasWrap.className = 'lsa-canvas-wrap';
        this._stopFFT();
        this._stopMicNow();
        this._setAzureViseme(0, { immediate: true });
        this._addMsg('Session ended', 'system');
        this._fire('onDisconnected');
      };
    }

    _stopSession() {
      this._stopMicNow();
      this._schedQueue = [];
      this._audioStart = 0;
      if (this._ws) { try { this._ws.close(); } catch(_) {} this._ws = null; }
    }

    // ─────────────────────────────────────────────────────
    //  AUDIO PLAYBACK
    // ─────────────────────────────────────────────────────
    _playPCM(int16Array) {
      const float32 = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) float32[i] = int16Array[i] / 32768;

      const buf = this._audioCtx.createBuffer(1, float32.length, OUT_RATE);
      buf.getChannelData(0).set(float32);

      const src = this._audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this._analyser);

      const now = this._audioCtx.currentTime;
      if (this._nextPlayAt < now + 0.01) this._nextPlayAt = now + 0.01;

      if (this._audioStart <= 0) {
        // mouthDelayMs: positive = delay anchor (mouth waits for late audio);
        // negative = advance anchor (mouth leads the audio).
        this._audioStart = this._nextPlayAt + (this._opts.mouthDelayMs / 1000);
        if (!this._schedRaf) this._driveSchedule();
      }

      src.start(this._nextPlayAt);
      this._nextPlayAt += buf.duration;
    }

    // ─────────────────────────────────────────────────────
    //  FFT ANALYSIS
    // ─────────────────────────────────────────────────────
    _startFFT() {
      this._stopFFT();
      this._analysisInt = setInterval(() => this._runFFT(), 1000 / ANALYSIS_HZ);
    }
    _stopFFT() {
      if (this._analysisInt) { clearInterval(this._analysisInt); this._analysisInt = null; }
    }

    _runFFT() {
      if (!this._analyser) return;
      const buf = new Uint8Array(this._analyser.frequencyBinCount);
      this._analyser.getByteFrequencyData(buf);
      const binHz = OUT_RATE / FFT_SIZE;

      const band = (lo, hi) => {
        let sum=0,n=0;
        const s=Math.max(0,Math.floor(lo/binHz)), e=Math.min(buf.length,Math.ceil(hi/binHz));
        for(let i=s;i<e;i++){sum+=buf[i]*buf[i];n++;}
        return n?sum/n/65025:0;
      };

      const raw = {
        sub:band(0,200),low:band(200,700),mid:band(700,2800),
        high:band(2800,7000),vhi:band(7000,12000),
      };
      for (const k of Object.keys(raw)) {
        this._fftBands[k] = (this._fftBands[k]||0)*(1-FFT_ALPHA) + raw[k]*FFT_ALPHA;
      }

      // Update band meter
      if (this._el.bandEls.length) {
        const MAX=0.025;
        const vals=[this._fftBands.sub||0,this._fftBands.low||0,this._fftBands.mid||0,
                    this._fftBands.high||0,this._fftBands.vhi||0];
        for(let i=0;i<5;i++){
          this._el.bandEls[i].style.height =
            `${Math.max(2,Math.min(vals[i]/MAX,1)*24)}px`;
        }
      }

      // FFT fallback silence detection
      if (this._schedQueue.length === 0 && this._audioStart > 0) {
        const vol = Object.values(this._fftBands).reduce((a,b)=>a+b,0)/5;
        if (vol < 0.00025) {
          this._silenceHoldMs += 1000/ANALYSIS_HZ;
          if (this._silenceHoldMs >= SILENCE_ENTER_MS) this._setAzureViseme(0);
        } else {
          this._silenceHoldMs = 0;
        }
      }
    }

    // ─────────────────────────────────────────────────────
    //  MICROPHONE
    // ─────────────────────────────────────────────────────
    async _startMicCapture() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this._micStream = stream;
        const micCtx = new AudioContext({ sampleRate: IN_RATE });
        const src    = micCtx.createMediaStreamSource(stream);
        const proc   = micCtx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e) => {
          if (!this._isConnected || !this._ws) return;
          const f32 = e.inputBuffer.getChannelData(0);
          const i16 = float32ToInt16(f32);
          this._ws.send(JSON.stringify({
            realtime_input: { audio: { data: int16ToBase64(i16), mime_type:`audio/pcm;rate=${IN_RATE}` } },
          }));
        };
        src.connect(proc);
        proc.connect(micCtx.destination);
        this._micProc = { proc, ctx: micCtx };
        this._isMicOn = true;
        this._el.btnMic.textContent = '🔴 Listening…';
        this._el.btnMic.classList.add('lsa-active');
        this._el.canvasWrap.classList.add('lsa-listening');
        this._el.canvasWrap.classList.remove('lsa-speaking');
        this._setStatus('Listening…', 'listening');
        if (this._behaviorCtrl) this._behaviorCtrl.setState('listening');
        this._fire('onListening');
      } catch(e) {
        this._showError(`Mic error: ${e.message}`);
        this._fire('onError', `Mic error: ${e.message}`);
      }
    }

    _stopMicNow() {
      if (!this._isMicOn) return;
      if (this._micProc) {
        try { this._micProc.proc.disconnect(); this._micProc.ctx.close(); } catch(_) {}
        this._micProc = null;
      }
      if (this._micStream) { this._micStream.getTracks().forEach(t=>t.stop()); this._micStream = null; }
      this._isMicOn = false;
      this._el.btnMic.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="2" width="6" height="12" rx="3"/>
          <path d="M5 10a7 7 0 0 0 14 0M12 19v3M8 22h8"/>
        </svg> Hold to speak`;
      this._el.btnMic.classList.remove('lsa-active');
      if (this._isConnected) {
        this._el.canvasWrap.className = 'lsa-canvas-wrap';
        this._setStatus('Listening…', 'connected');
        if (this._ws) {
          try { this._ws.send(JSON.stringify({ realtime_input: { audio_stream_end: true } })); } catch(_) {}
        }
      }
    }

    // ─────────────────────────────────────────────────────
    //  UI HELPERS
    // ─────────────────────────────────────────────────────
    _setStatus(label, dotClass) {
      this._el.statusLabel.textContent = label;
      this._el.dot.className = 'lsa-status-dot' + (dotClass ? ` ${dotClass}` : '');
    }

    _showError(msg) {
      this._el.errorBar.textContent = msg;
      this._el.errorBar.style.display = 'block';
      setTimeout(() => { this._el.errorBar.style.display = 'none'; }, 6000);
    }

    _addMsg(text, role) {
      if (!this._el.transcript) return;
      const div = document.createElement('div');
      div.className = `lsa-msg ${role}`;
      div.textContent = text;
      this._el.transcript.appendChild(div);
      this._el.transcript.scrollTop = this._el.transcript.scrollHeight;
    }

    _fire(event, ...args) {
      if (typeof this._opts[event] === 'function') {
        try { this._opts[event](...args); } catch(e) { console.error('[LipsyncAvatar] Event error:', e); }
      }
    }
  }

  return LipsyncAvatar;
}));

// ── AvatarPlatform async namespace ────────────────────────────
// Exposed as window.AvatarPlatform for headless usage independent
// of the LipsyncAvatar class (no Rive, no WebSocket required).
(function () {
  'use strict';

  const AP = window.AvatarPlatform = window.AvatarPlatform || {};

  // Resolve the server origin from the script tag's own src URL.
  // Falls back to window.location.origin when called from a module context.
  function _origin() {
    if (typeof document !== 'undefined') {
      const scripts = document.querySelectorAll('script[src]');
      for (let i = scripts.length - 1; i >= 0; i--) {
        const src = scripts[i].getAttribute('src') || '';
        if (src.includes('lipsync-sdk')) {
          try { return new URL(src, window.location.href).origin; } catch (_) {}
        }
      }
    }
    return (typeof window !== 'undefined' ? window.location.origin : '');
  }

  // Cache for preloaded configs  keyed by botId.
  const _configCache = new Map();

  /**
   * AvatarPlatform.preload(botId)
   * Pre-fetches the bot configuration and caches it in the browser.
   * Call early (on page load, on hover) to eliminate first-open latency.
   */
  AP.preload = function preload(botId) {
    if (_configCache.has(botId)) return Promise.resolve(_configCache.get(botId));
    const url = _origin() + '/embed/' + encodeURIComponent(botId) + '/config';
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('AvatarPlatform.preload: ' + r.status);
        return r.json();
      })
      .then(function (cfg) {
        _configCache.set(botId, cfg);
        return cfg;
      });
  };

  /**
   * AvatarPlatform.ask(botId, question, sessionId?)
   * Send a question and get back { answer, sources, sessionId }.
   * Does not require voice, WebSocket, or the widget to be visible.
   */
  AP.ask = function ask(botId, question, sessionId) {
    const url = _origin() + '/embed/' + encodeURIComponent(botId) + '/ask';
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question, sessionId: sessionId || undefined }),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'AvatarPlatform.ask: ' + r.status); });
      return r.json();
    });
  };
}());
