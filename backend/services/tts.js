/**
 * Text-to-speech service for the "TTS-only" voice engines (Fish Audio,
 * Cartesia, ElevenLabs) — alternatives to the default Gemini Live
 * speech-to-speech engine for owners who want a specific voice model
 * instead of Gemini's built-in ones. Unlike Gemini Live / OpenAI Realtime,
 * these providers only synthesize audio from text — they don't do speech
 * understanding or a live session, so the reply text itself still comes
 * from the existing Gemini RAG pipeline (see POST /embed/:publicId/ask)
 * and this service is called afterward, server-side, to turn that text
 * into audio.
 *
 * Configure via env vars (only the ones for engines you actually use):
 *   FISH_AUDIO_API_KEY   — https://fish.audio API key
 *   CARTESIA_API_KEY     — https://cartesia.ai API key
 *   CARTESIA_MODEL_ID    — default 'sonic-3.5'
 *   CARTESIA_VERSION     — default '2026-08-14' (required date-versioned API header)
 *   ELEVENLABS_API_KEY   — https://elevenlabs.io API key
 *   ELEVENLABS_MODEL_ID  — default 'eleven_multilingual_v2'
 *
 * Request/response shapes below were verified directly against each
 * provider's official Node SDK source (this sandbox's egress proxy blocks
 * the vendor doc sites themselves, but not the npm registry, so the SDKs'
 * actual request-building and response-parsing code was inspected instead):
 *   elevenlabs / @elevenlabs/elevenlabs-js — confirmed exact: endpoint,
 *     headers, body fields, and the with-timestamps response shape below.
 *   @cartesia/cartesia-js@4.1.0 — caught and fixed three real bugs an
 *     earlier unverified version of this file had: auth is `Authorization:
 *     Bearer <key>`, not `X-API-Key`; `voice` is a plain ID string (or
 *     `{id}`), not `{mode:'id', id}`; and the required `cartesia-version`
 *     header needs a currently-valid date, not a guessed one.
 *   fish-audio-sdk@2025.11.29 — confirmed exact: endpoint, headers, and body
 *     fields (including `format: 'pcm'` as a valid enum value).
 * If a provider changes their API after this was written, re-run the same
 * check: `npm install <official-sdk-package>` somewhere and read its
 * request-building source rather than guessing again.
 *
 * Output contract: synthesizeSpeech() always resolves to raw PCM16 little-
 * endian, mono, 24kHz audio as a Buffer — matching public/lipsync-sdk.js's
 * OUT_RATE constant, so the widget can feed it straight into the avatar's
 * existing playback/lip-sync pipeline with no client-side resampling. All
 * three providers are asked for that format directly; as a defensive
 * fallback (in case a provider ignores the requested format or wraps it in
 * a WAV container) a leading "RIFF" header is detected and stripped so a
 * plain PCM buffer comes out either way.
 *
 * ElevenLabs is also asked for its "with-timestamps" endpoint, a
 * lesser-known variant of its TTS API that returns per-CHARACTER start/end
 * times for the synthesized audio alongside the audio itself. That's a
 * different — and far more useful — signal than a full-utterance duration:
 * it captures the model's real (non-uniform) pacing, including pauses and
 * emphasis, per character of input text. public/lipsync-sdk.js's
 * warpScheduleToAlignment() uses it to correct the same G2P-based
 * phoneme→viseme timeline already built for Gemini Live's text-only
 * estimation, rather than falling back to amplitude-only mouth movement
 * (see speakPCMWithAlignment() vs. speakPCM()).
 */
const fetch = require('node-fetch');
const logger = require('../logger').child({ module: 'services/tts' });

const PCM_SAMPLE_RATE = 24000;

const ENGINES = ['fish-audio', 'cartesia', 'elevenlabs'];

class TtsError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'TtsError';
    this.status = status;
  }
}

/** Strip a RIFF/WAVE header if present, so callers always get raw PCM samples. */
function stripWavHeader(buf) {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    // Walk chunks to find "data" rather than assuming a fixed 44-byte header
    // (some encoders add extra chunks like LIST/fmt extensions before it).
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const chunkId = buf.toString('ascii', offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === 'data') return buf.subarray(offset + 8, offset + 8 + chunkSize);
      offset += 8 + chunkSize + (chunkSize % 2);
    }
  }
  return buf;
}

async function synthesizeFishAudio(voiceId, text) {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) throw new TtsError('Fish Audio is not configured on this server (missing FISH_AUDIO_API_KEY).');

  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Matches the default the official fish-audio-sdk sends on every
      // request when the caller doesn't override it — not account-specific.
      'developer-id': '6322d9df15d044e7b928de27c863480f',
    },
    body: JSON.stringify({
      text,
      reference_id: voiceId || undefined,
      format: 'pcm',
      sample_rate: PCM_SAMPLE_RATE,
      normalize: true,
    }),
    timeout: 20000,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: body.slice(0, 500) }, 'Fish Audio TTS request failed');
    throw new TtsError(`Fish Audio TTS request failed (${res.status})`, { status: res.status });
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return stripWavHeader(buf);
}

async function synthesizeCartesia(voiceId, text) {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) throw new TtsError('Cartesia is not configured on this server (missing CARTESIA_API_KEY).');
  if (!voiceId) throw new TtsError('This project has no Cartesia voice ID configured.');

  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'cartesia-version': process.env.CARTESIA_VERSION || '2026-08-14',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: process.env.CARTESIA_MODEL_ID || 'sonic-3.5',
      transcript: text,
      // A plain voice-ID string is a valid VoiceSpecifier — no {mode:'id'}
      // wrapper (that shape belongs to an older API version).
      voice: voiceId,
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: PCM_SAMPLE_RATE },
      // No `language`/`locale` field: it's optional, and this platform is
      // multilingual (see lipsync-sdk.js's 13-language G2P) — forcing 'en'
      // here would mispronounce every non-English reply.
    }),
    timeout: 20000,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: body.slice(0, 500) }, 'Cartesia TTS request failed');
    throw new TtsError(`Cartesia TTS request failed (${res.status})`, { status: res.status });
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return stripWavHeader(buf);
}

/**
 * ElevenLabs' "with-timestamps" endpoint — same synthesis as its regular TTS
 * endpoint, but the response is JSON carrying both the audio and a character-
 * level `alignment` (parallel arrays: characters, their start times, their
 * end times, all in seconds from the start of the audio). Requesting
 * output_format=pcm_24000 gets raw PCM16LE samples back in `audio_base64`
 * (no WAV wrapper) — stripWavHeader() below is only a defensive fallback in
 * case that changes.
 */
async function synthesizeElevenLabs(voiceId, text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new TtsError('ElevenLabs is not configured on this server (missing ELEVENLABS_API_KEY).');
  if (!voiceId) throw new TtsError('This project has no ElevenLabs voice ID configured.');

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=pcm_${PCM_SAMPLE_RATE}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
      }),
      timeout: 20000,
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: body.slice(0, 500) }, 'ElevenLabs TTS request failed');
    throw new TtsError(`ElevenLabs TTS request failed (${res.status})`, { status: res.status });
  }

  const data = await res.json();
  const pcm = stripWavHeader(Buffer.from(data.audio_base64, 'base64'));
  const a = data.alignment || {};

  return {
    pcm,
    alignment: (a.characters && a.characters.length)
      ? {
          characters: a.characters,
          characterStartTimesSeconds: a.character_start_times_seconds,
          characterEndTimesSeconds: a.character_end_times_seconds,
        }
      : null,
  };
}

/**
 * @param {{ engine: 'fish-audio'|'cartesia'|'elevenlabs', voiceId: string, text: string }} opts
 * @returns {Promise<{ audioBase64: string, mimeType: string, sampleRate: number, alignment: object|null }>}
 */
async function synthesizeSpeech({ engine, voiceId, text }) {
  if (!ENGINES.includes(engine)) throw new TtsError(`Unsupported voice engine: ${engine}`);
  if (!text || !text.trim()) throw new TtsError('No text to speak');

  let pcm, alignment = null;
  if (engine === 'fish-audio') {
    pcm = await synthesizeFishAudio(voiceId, text);
  } else if (engine === 'cartesia') {
    pcm = await synthesizeCartesia(voiceId, text);
  } else {
    ({ pcm, alignment } = await synthesizeElevenLabs(voiceId, text));
  }

  return {
    audioBase64: pcm.toString('base64'),
    mimeType: 'audio/pcm;rate=24000',
    sampleRate: PCM_SAMPLE_RATE,
    alignment,
  };
}

module.exports = { synthesizeSpeech, TtsError, ENGINES };
