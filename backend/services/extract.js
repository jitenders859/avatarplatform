/**
 * File → text extraction.
 *
 *   text / markdown    → fs read
 *   pdf                → pdf-parse
 *   docx               → mammoth
 *   doc (legacy)       → best-effort (informs user to convert)
 *   image              → Gemini Vision caption
 *   audio              → Gemini audio transcription
 *   video              → Gemini video transcription + scene description
 *
 * All uploads route through `extractFile()` which dispatches by mimetype/ext.
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const PLATFORM_KEY = process.env.GEMINI_API_KEY || '';
const VISION_MODEL = 'gemini-2.0-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const TEXT_EXT  = ['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm'];
const PDF_EXT   = ['.pdf'];
const DOCX_EXT  = ['.docx'];
const DOC_EXT   = ['.doc'];
const IMG_EXT   = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'];
const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.avi'];

const MIME_BY_EXT = {
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif',
  '.webp':'image/webp','.bmp':'image/bmp',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg',
  '.flac':'audio/flac','.aac':'audio/aac',
  '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska',
};

function classify(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (TEXT_EXT.includes(ext))  return 'text';
  if (PDF_EXT.includes(ext))   return 'pdf';
  if (DOCX_EXT.includes(ext))  return 'docx';
  if (DOC_EXT.includes(ext))   return 'doc';
  if (IMG_EXT.includes(ext))   return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return 'unknown';
}

// ── Text-based formats ────────────────────────────────────────

async function extractText(filepath) {
  return fs.promises.readFile(filepath, 'utf8');
}

async function extractPdf(filepath) {
  const buf = await fs.promises.readFile(filepath);
  const data = await pdfParse(buf);
  return data.text || '';
}

async function extractDocx(filepath) {
  const result = await mammoth.extractRawText({ path: filepath });
  return result.value || '';
}

async function extractDoc(filepath) {
  // Legacy .doc requires a converter (e.g. libreoffice). Surface a clear
  // message so the upload pipeline can mark the file as failed-with-reason.
  throw new Error('.doc (legacy Word) is not supported. Please save as .docx and re-upload.');
}

// ── Multimodal via Gemini ─────────────────────────────────────

/**
 * Send a file to Gemini as inline_data and get back text. Used for image
 * captions, audio transcription, and video description. Inline data is
 * capped by Gemini at ~20MB; larger files would need the Files API.
 */
async function geminiMultimodal(filepath, mimeType, prompt) {
  if (!PLATFORM_KEY) throw new Error('GEMINI_API_KEY not configured on server');
  const stat = await fs.promises.stat(filepath);
  if (stat.size > 19 * 1024 * 1024) {
    throw new Error(`File too large for inline processing (${(stat.size / 1024 / 1024).toFixed(1)}MB > 19MB). Split into smaller pieces.`);
  }
  const buf = await fs.promises.readFile(filepath);
  const b64 = buf.toString('base64');

  const url = `${BASE}/models/${VISION_MODEL}:generateContent?key=${PLATFORM_KEY}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType, data: b64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini ${VISION_MODEL} ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('\n').trim();
}

async function extractImage(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'image/jpeg';
  const prompt = `Describe this image in detail for a knowledge-base index. Include:
- What is shown (objects, people, scene)
- Any visible text or numbers (transcribe verbatim)
- Diagrams, charts, or technical content (explain what they represent)
- Brand names, product names, logos
Respond as plain prose, no markdown headers.`;
  return geminiMultimodal(filepath, mime, prompt);
}

async function extractAudio(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'audio/mpeg';
  const prompt = `Transcribe this audio verbatim. After the transcript, on a new line starting with "SUMMARY:", give a 2-3 sentence summary of what is discussed. Keep speaker names if you can identify them, otherwise use Speaker A/B.`;
  return geminiMultimodal(filepath, mime, prompt);
}

async function extractVideo(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'video/mp4';
  const prompt = `Process this video for a searchable knowledge base. Provide:
1. A full transcript of any spoken content (with rough timestamps in [MM:SS] format).
2. After the transcript, a "VISUAL DESCRIPTION:" section describing what is shown across the video — scenes, on-screen text, key visuals.
3. A "SUMMARY:" section with 3-4 sentences capturing the overall content.`;
  return geminiMultimodal(filepath, mime, prompt);
}

// ── Public dispatch ───────────────────────────────────────────

async function extractFile(filepath, originalName) {
  const kind = classify(originalName || filepath);
  switch (kind) {
    case 'text':  return { kind, text: await extractText(filepath) };
    case 'pdf':   return { kind, text: await extractPdf(filepath) };
    case 'docx':  return { kind, text: await extractDocx(filepath) };
    case 'doc':   return { kind, text: await extractDoc(filepath) };
    case 'image': return { kind, text: await extractImage(filepath) };
    case 'audio': return { kind, text: await extractAudio(filepath) };
    case 'video': return { kind, text: await extractVideo(filepath) };
    default:
      throw new Error(`Unsupported file type: ${path.extname(originalName)}`);
  }
}

module.exports = { extractFile, classify };
