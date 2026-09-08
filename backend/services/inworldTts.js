/**
 * Text-to-speech library for Inworld's Realtime TTS-2 models (`inworld-tts-2`
 * and `inworld-tts-2-flash`) — NOT wired into the app's active voice-engine
 * selector (backend/services/tts.js's synthesizeSpeech(), VOICE_ENGINES in
 * backend/middleware/validate.js). This module is standalone on purpose so
 * it can be tried out (see POST /api/admin/inworld-tts-test) without
 * changing what any real visitor hears today. Wiring it into the live
 * selector later is a small follow-up: add 'inworld-tts-2'/'inworld-tts-2-
 * flash' to VOICE_ENGINES and a case in tts.js's synthesizeSpeech() that
 * calls synthesizeInworldSpeech() from here.
 *
 * Configure via:
 *   INWORLD_API_KEY  — from https://platform.inworld.ai (already the base64
 *                       key:secret pair Inworld hands out — used as-is)
 *   INWORLD_VOICE_ID — optional default voice, if callers don't pass one
 *
 * Request/response shapes below were verified against the official
 * @inworld/tts Node SDK source (`npm install @inworld/tts` and read
 * src/client.js), not guessed:
 *   - Base URL https://api.inworld.ai, endpoint POST /tts/v1/voice.
 *   - Auth header: `Authorization: Basic <INWORLD_API_KEY>` — no further
 *     encoding; the key from the portal is already the base64 pair.
 *   - Request body: { text, voiceId, modelId, audioConfig: { audioEncoding,
 *     sampleRateHertz, speakingRate }, temperature, timestampType }.
 *     audioEncoding: 'PCM' returns raw PCM16LE samples with no container.
 *   - Response: { audioContent: <base64>, timestampInfo }. With
 *     timestampType: 'WORD', timestampInfo.wordAlignment carries
 *     { words, wordStartTimeSeconds, wordEndTimeSeconds, phoneticDetails:
 *     [{ wordIndex, phones: [{ phoneSymbol, startTimeSeconds,
 *     durationSeconds, visemeSymbol }] }] } — confirmed against both the SDK
 *     source and docs.inworld.ai/tts/capabilities/timestamps.
 * If Inworld changes their API after this was written, re-run the same
 * check rather than guessing again.
 *
 * Output contract: synthesizeInworldSpeech() resolves audio as raw PCM16
 * little-endian, mono, 24kHz — matching backend/services/tts.js's
 * synthesizeSpeech() contract, so wiring this in later is a drop-in, not a
 * rewrite.
 *
 * Timestamps: Inworld's `timestampType` is WORD *or* CHARACTER, never both
 * in one call — only WORD includes phoneme/viseme data. This module always
 * requests WORD (to get phonemes) and derives an approximate per-character
 * `alignment` by splitting each word/punctuation/whitespace token's
 * [start, end] span evenly across its characters. That derived shape
 * matches ElevenLabs' with-timestamps alignment shape (see tts.js) so
 * public/lipsync-sdk.js's warpScheduleToAlignment() could consume it
 * unchanged if this is ever wired in — but it is an approximation, not
 * measured per-character timing (real character timing from Inworld is not
 * obtainable in the same call as phonemes).
 */
const fetch = require('node-fetch');
const logger = require('../logger').child({ module: 'services/inworldTts' });

const PCM_SAMPLE_RATE = 24000;
const BASE_URL = 'https://api.inworld.ai';

const MODELS = ['tts-2', 'tts-2-flash'];
const MODEL_IDS = {
  'tts-2': 'inworld-tts-2',
  'tts-2-flash': 'inworld-tts-2-flash',
};

class InworldTtsError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'InworldTtsError';
    this.status = status;
  }
}

/**
 * Strip a RIFF/WAVE header if present, so callers always get raw PCM
 * samples. A small standalone copy of the same defensive check in tts.js —
 * duplicated rather than imported so this module has no dependency on the
 * rest of the voice-engine code (see file header).
 */
function stripWavHeader(buf) {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
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

/**
 * Approximate per-character timing by splitting each token's [start, end]
 * span evenly across its characters. Inworld's WORD-level tokens already
 * include punctuation and whitespace as separate entries, so this is closer
 * to true character timing than splitting whole sentences would be — but it
 * is still an approximation, not measured per-character data.
 */
function deriveCharacterAlignment(words, wordStartTimeSeconds, wordEndTimeSeconds) {
  const characters = [];
  const characterStartTimesSeconds = [];
  const characterEndTimesSeconds = [];

  for (let i = 0; i < words.length; i++) {
    const token = words[i];
    const start = wordStartTimeSeconds[i];
    const end = wordEndTimeSeconds[i];
    const duration = end - start;
    const len = token.length;
    for (let c = 0; c < len; c++) {
      characters.push(token[c]);
      characterStartTimesSeconds.push(start + (duration * c) / len);
      characterEndTimesSeconds.push(start + (duration * (c + 1)) / len);
    }
  }

  return { characters, characterStartTimesSeconds, characterEndTimesSeconds };
}

/** Flatten timestampInfo.wordAlignment.phoneticDetails into a single ordered list. */
function extractPhonemes(phoneticDetails) {
  const phonemes = [];
  for (const detail of phoneticDetails || []) {
    for (const phone of detail.phones || []) {
      phonemes.push({
        phoneme: phone.phoneSymbol,
        viseme: phone.visemeSymbol,
        startSeconds: phone.startTimeSeconds,
        endSeconds: phone.startTimeSeconds + phone.durationSeconds,
        wordIndex: detail.wordIndex,
      });
    }
  }
  return phonemes;
}

/**
 * @param {{ model: 'tts-2'|'tts-2-flash', voiceId?: string, text: string }} opts
 * @returns {Promise<{
 *   audioBase64: string, mimeType: string, sampleRate: number,
 *   alignment: { characters: string[], characterStartTimesSeconds: number[], characterEndTimesSeconds: number[] } | null,
 *   phonemes: { phoneme: string, viseme: string, startSeconds: number, endSeconds: number, wordIndex: number }[] | null,
 *   words: { words: string[], wordStartTimeSeconds: number[], wordEndTimeSeconds: number[] } | null,
 * }>}
 */
async function synthesizeInworldSpeech({ model, voiceId, text }) {
  if (!MODELS.includes(model)) throw new InworldTtsError(`Unsupported Inworld model: ${model}`);
  if (!text || !text.trim()) throw new InworldTtsError('No text to speak');

  const apiKey = process.env.INWORLD_API_KEY;
  if (!apiKey) throw new InworldTtsError('Inworld TTS is not configured on this server (missing INWORLD_API_KEY).');

  const resolvedVoiceId = voiceId || process.env.INWORLD_VOICE_ID;
  if (!resolvedVoiceId) throw new InworldTtsError('This project has no Inworld voice ID configured.');

  const res = await fetch(`${BASE_URL}/tts/v1/voice`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      voiceId: resolvedVoiceId,
      modelId: MODEL_IDS[model],
      audioConfig: {
        audioEncoding: 'PCM',
        sampleRateHertz: PCM_SAMPLE_RATE,
        speakingRate: 1.0,
      },
      temperature: 1.0,
      timestampType: 'WORD',
    }),
    timeout: 20000,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: body.slice(0, 500) }, 'Inworld TTS request failed');
    throw new InworldTtsError(`Inworld TTS request failed (${res.status})`, { status: res.status });
  }

  const data = await res.json();
  if (!data.audioContent) throw new InworldTtsError('Inworld TTS response is missing audioContent');

  const pcm = stripWavHeader(Buffer.from(data.audioContent, 'base64'));
  const wordAlignment = data.timestampInfo && data.timestampInfo.wordAlignment;
  const hasWords = !!(wordAlignment && wordAlignment.words && wordAlignment.words.length);

  return {
    audioBase64: pcm.toString('base64'),
    mimeType: 'audio/pcm;rate=24000',
    sampleRate: PCM_SAMPLE_RATE,
    alignment: hasWords
      ? deriveCharacterAlignment(wordAlignment.words, wordAlignment.wordStartTimeSeconds, wordAlignment.wordEndTimeSeconds)
      : null,
    phonemes: hasWords ? extractPhonemes(wordAlignment.phoneticDetails) : null,
    words: hasWords
      ? {
          words: wordAlignment.words,
          wordStartTimeSeconds: wordAlignment.wordStartTimeSeconds,
          wordEndTimeSeconds: wordAlignment.wordEndTimeSeconds,
        }
      : null,
  };
}

module.exports = { synthesizeInworldSpeech, InworldTtsError, MODELS };
