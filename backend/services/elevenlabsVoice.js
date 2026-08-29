/**
 * Voice cloning (see docs/competitor-feature-implementation-plan.md 2c) —
 * ElevenLabs' "Instant Voice Cloning" API. Uses Node's built-in global
 * fetch/FormData/Blob (undici, Node 18+) rather than node-fetch, since
 * node-fetch v2 doesn't accept the native FormData spec object as a body
 * and this project has no form-data dependency — this is a fixed, trusted
 * host (not caller-supplied), so services/safeFetch.js's SSRF guard doesn't
 * apply here.
 *
 * NOTE: this only creates the cloned voice and returns its ID — it does
 * NOT wire up playback. The `el:<voiceId>` convention documented in
 * public/docs/elevenlabs-avatar.html (and the /embed/:publicId/tts proxy it
 * describes) does not actually exist in this codebase; that page is stale
 * documentation for a feature that was never built. Storing project.voice
 * as `el:<voiceId>` here matches that documented convention so the two
 * line up if/when the TTS proxy is actually built, but until then the
 * cloned voice is not used by the widget.
 */
async function cloneVoice({ name, buffer, mimeType, filename }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    const err = new Error('Voice cloning is not configured on this server (ELEVENLABS_API_KEY unset).');
    err.status = 503;
    throw err;
  }

  const form = new FormData();
  form.append('name', name);
  form.append('files', new Blob([buffer], { type: mimeType || 'audio/mpeg' }), filename || 'sample.mp3');

  const res = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`ElevenLabs voice clone failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  if (!data.voice_id) {
    const err = new Error('ElevenLabs response did not include a voice_id');
    err.status = 502;
    throw err;
  }
  return data.voice_id;
}

module.exports = { cloneVoice };
