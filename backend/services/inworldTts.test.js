/**
 * synthesizeInworldSpeech() — standalone Inworld TTS-2 / TTS-2 Flash library
 * (backend/services/inworldTts.js). Not wired into any product route yet;
 * covers the request shape, the derived character alignment (Inworld only
 * gives word-level timing alongside phonemes, so per-character timing is
 * approximated by splitting each word's span across its characters), and
 * the validation/error paths.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

let fetchCalls;
let fetchResponse;

function reload() {
  for (const mod of ['./inworldTts', 'node-fetch']) {
    delete require.cache[require.resolve(mod)];
  }

  fetchCalls = [];
  fetchResponse = null;

  stubFile('node-fetch', async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchResponse;
  });

  return require('./inworldTts');
}

function okResponse(body) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errResponse(status, body = '') {
  return {
    ok: false,
    status,
    text: async () => body,
  };
}

const WORD_TIMESTAMP_BODY = {
  audioContent: Buffer.from([1, 2, 3, 4]).toString('base64'),
  timestampInfo: {
    wordAlignment: {
      words: ['Hi', ' ', 'Bob'],
      wordStartTimeSeconds: [0, 0.2, 0.3],
      wordEndTimeSeconds: [0.2, 0.3, 0.7],
      phoneticDetails: [
        { wordIndex: 0, phones: [{ phoneSymbol: 'HH', startTimeSeconds: 0, durationSeconds: 0.1, visemeSymbol: 'PP' }] },
        { wordIndex: 2, phones: [{ phoneSymbol: 'B', startTimeSeconds: 0.3, durationSeconds: 0.05, visemeSymbol: 'BB' }] },
      ],
    },
  },
};

process.env.INWORLD_API_KEY = 'test-key';

test('synthesizeInworldSpeech: sends the verified request shape', async () => {
  const { synthesizeInworldSpeech } = reload();
  fetchResponse = okResponse(WORD_TIMESTAMP_BODY);

  await synthesizeInworldSpeech({ model: 'tts-2-flash', voiceId: 'v1', text: 'Hi Bob' });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://api.inworld.ai/tts/v1/voice');
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Basic test-key');
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.modelId, 'inworld-tts-2-flash');
  assert.equal(body.voiceId, 'v1');
  assert.equal(body.audioConfig.audioEncoding, 'PCM');
  assert.equal(body.audioConfig.sampleRateHertz, 24000);
  assert.equal(body.timestampType, 'WORD');
});

test('synthesizeInworldSpeech: derives per-character alignment from word timing', async () => {
  const { synthesizeInworldSpeech } = reload();
  fetchResponse = okResponse(WORD_TIMESTAMP_BODY);

  const result = await synthesizeInworldSpeech({ model: 'tts-2', voiceId: 'v1', text: 'Hi Bob' });

  assert.deepEqual(result.alignment.characters, ['H', 'i', ' ', 'B', 'o', 'b']);
  // "Hi" spans [0, 0.2] over 2 chars → 0.1s each
  assert.equal(result.alignment.characterStartTimesSeconds[0], 0);
  assert.equal(result.alignment.characterEndTimesSeconds[0], 0.1);
  assert.equal(result.alignment.characterStartTimesSeconds[1], 0.1);
  assert.equal(result.alignment.characterEndTimesSeconds[1], 0.2);
});

test('synthesizeInworldSpeech: flattens phonetic details into an ordered phoneme list', async () => {
  const { synthesizeInworldSpeech } = reload();
  fetchResponse = okResponse(WORD_TIMESTAMP_BODY);

  const result = await synthesizeInworldSpeech({ model: 'tts-2', voiceId: 'v1', text: 'Hi Bob' });

  assert.equal(result.phonemes.length, 2);
  assert.equal(result.phonemes[0].phoneme, 'HH');
  assert.equal(result.phonemes[0].viseme, 'PP');
  assert.equal(result.phonemes[0].endSeconds, 0.1);
  assert.equal(result.phonemes[1].wordIndex, 2);
});

test('synthesizeInworldSpeech: audio comes back as base64 PCM with the tts.js-matching mime/sampleRate', async () => {
  const { synthesizeInworldSpeech } = reload();
  fetchResponse = okResponse(WORD_TIMESTAMP_BODY);

  const result = await synthesizeInworldSpeech({ model: 'tts-2', voiceId: 'v1', text: 'Hi Bob' });

  assert.equal(result.audioBase64, Buffer.from([1, 2, 3, 4]).toString('base64'));
  assert.equal(result.mimeType, 'audio/pcm;rate=24000');
  assert.equal(result.sampleRate, 24000);
});

test('synthesizeInworldSpeech: rejects an unsupported model before any network call', async () => {
  const { synthesizeInworldSpeech, InworldTtsError } = reload();
  await assert.rejects(
    () => synthesizeInworldSpeech({ model: 'tts-1', voiceId: 'v1', text: 'Hi' }),
    InworldTtsError
  );
  assert.equal(fetchCalls.length, 0);
});

test('synthesizeInworldSpeech: rejects empty text before any network call', async () => {
  const { synthesizeInworldSpeech, InworldTtsError } = reload();
  await assert.rejects(
    () => synthesizeInworldSpeech({ model: 'tts-2', voiceId: 'v1', text: '   ' }),
    InworldTtsError
  );
  assert.equal(fetchCalls.length, 0);
});

test('synthesizeInworldSpeech: rejects a missing voiceId (no project/env default) before any network call', async () => {
  const { synthesizeInworldSpeech, InworldTtsError } = reload();
  await assert.rejects(
    () => synthesizeInworldSpeech({ model: 'tts-2', voiceId: undefined, text: 'Hi' }),
    InworldTtsError
  );
  assert.equal(fetchCalls.length, 0);
});

test('synthesizeInworldSpeech: a non-2xx response is surfaced as InworldTtsError with the status attached', async () => {
  const { synthesizeInworldSpeech, InworldTtsError } = reload();
  fetchResponse = errResponse(429, 'rate limited');

  await assert.rejects(
    () => synthesizeInworldSpeech({ model: 'tts-2', voiceId: 'v1', text: 'Hi' }),
    (err) => {
      assert.ok(err instanceof InworldTtsError);
      assert.equal(err.status, 429);
      return true;
    }
  );
});

test('synthesizeInworldSpeech: no timestampInfo in the response yields null alignment/phonemes, not a throw', async () => {
  const { synthesizeInworldSpeech } = reload();
  fetchResponse = okResponse({ audioContent: Buffer.from([9]).toString('base64') });

  const result = await synthesizeInworldSpeech({ model: 'tts-2', voiceId: 'v1', text: 'Hi' });
  assert.equal(result.alignment, null);
  assert.equal(result.phonemes, null);
  assert.equal(result.words, null);
});
