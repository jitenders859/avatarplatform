/**
 * Text-to-speech service for the "TTS-only" voice engines (Fish Audio,
 * Cartesia) — alternatives to the default Gemini Live speech-to-speech
 * engine for owners who want a specific voice model instead of Gemini's
 * built-in ones. Unlike Gemini Live / OpenAI Realtime, these providers only
 * synthesize audio from text — they don't do speech understanding or a live
 * session, so the reply text itself still comes from the existing Gemini
 * RAG pipeline (see POST /embed/:publicId/ask) and this service is called
 * afterward, server-side, to turn that text into audio.
 *
 * Configure via env vars (only the ones for engines you actually use):
 *   FISH_AUDIO_API_KEY  — https://fish.audio API key
 *   CARTESIA_API_KEY    — https://cartesia.ai API key
 *   CARTESIA_MODEL_ID   — default 'sonic-3.5'
 *
 * Output contract: synthesizeSpeech() always resolves to raw PCM16 little-
 * endian, mono, 24kHz audio as a Buffer — matching public/lipsync-sdk.js's
 * OUT_RATE constant, so the widget can feed it straight into the avatar's
 * existing playback/lip-sync pipeline (avatar.speakPCM) with no client-side
 * resampling. Both providers are asked for that format directly; as a
 * defensive fallback (in case a provider ignores the requested format or
 * wraps it in a WAV container) a leading "RIFF" header is detected and
 * stripped so a plain PCM buffer comes out either way.
 */
const fetch = require('node-fetch');
const logger = require('../logger').child({ module: 'services/tts' });

const PCM_SAMPLE_RATE = 24000;

const ENGINES = ['fish-audio', 'cartesia'];

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
      'X-API-Key': apiKey,
      'Cartesia-Version': process.env.CARTESIA_VERSION || '2025-04-16',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: process.env.CARTESIA_MODEL_ID || 'sonic-3.5',
      transcript: text,
      voice: { mode: 'id', id: voiceId },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: PCM_SAMPLE_RATE },
      language: 'en',
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
 * @param {{ engine: 'fish-audio'|'cartesia', voiceId: string, text: string }} opts
 * @returns {Promise<{ audioBase64: string, mimeType: string, sampleRate: number }>}
 */
async function synthesizeSpeech({ engine, voiceId, text }) {
  if (!ENGINES.includes(engine)) throw new TtsError(`Unsupported voice engine: ${engine}`);
  if (!text || !text.trim()) throw new TtsError('No text to speak');

  const pcm = engine === 'fish-audio'
    ? await synthesizeFishAudio(voiceId, text)
    : await synthesizeCartesia(voiceId, text);

  return {
    audioBase64: pcm.toString('base64'),
    mimeType: 'audio/pcm;rate=24000',
    sampleRate: PCM_SAMPLE_RATE,
  };
}

module.exports = { synthesizeSpeech, TtsError, ENGINES };
