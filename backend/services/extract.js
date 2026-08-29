/**
 * File → text extraction.
 *
 *   text / markdown    → decode buffer
 *   pdf                → pdf-parse
 *   docx               → mammoth
 *   doc (legacy)       → best-effort (informs user to convert)
 *   image              → Gemini Vision caption
 *   audio              → Gemini audio transcription
 *   video              → Gemini video transcription + scene description
 *
 * All uploads route through `extractFile()` which dispatches by mimetype/ext.
 * Operates on in-memory Buffers (not local file paths) — files live in
 * Supabase Storage, downloaded once by the caller (backend/services/
 * process.js) and passed straight through.
 */
const path = require('path');
const fetch = require('node-fetch');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const settings = require('./settings');

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

async function extractText(buffer) {
  return buffer.toString('utf8');
}

/**
 * Returns { text, pages } — pages is per-page text with real page numbers,
 * captured via a custom pagerender callback rather than pdf-parse's own
 * text concatenation (which joins pages with a plain blank line, not a
 * form feed, so page boundaries aren't otherwise recoverable from the
 * text). chunk.js's chunkPages() uses `pages` to tag chunks with accurate
 * page numbers; `text` is kept for callers that just want the flat string.
 */
async function extractPdf(buffer) {
  const pages = [];
  await pdfParse(buffer, {
    pagerender: async pageData => {
      const content = await pageData.getTextContent();
      const text = content.items.map(item => item.str).join(' ');
      pages.push({ pageNumber: pageData.pageNumber, text });
      return text;
    },
  });
  return { text: pages.map(p => p.text).join('\n\n'), pages };
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

async function extractDoc(buffer) {
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
async function geminiMultimodal(buffer, mimeType, prompt) {
  const platformKey = await settings.getSetting('GEMINI_API_KEY');
  if (!platformKey) throw new Error('GEMINI_API_KEY not configured on server');
  if (buffer.length > 19 * 1024 * 1024) {
    throw new Error(`File too large for inline processing (${(buffer.length / 1024 / 1024).toFixed(1)}MB > 19MB). Split into smaller pieces.`);
  }
  const b64 = buffer.toString('base64');

  const url = `${BASE}/models/${VISION_MODEL}:generateContent?key=${platformKey}`;
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

async function extractImage(buffer, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'image/jpeg';
  const prompt = `Describe this image in detail for a knowledge-base index. Include:
- What is shown (objects, people, scene)
- Any visible text or numbers (transcribe verbatim)
- Diagrams, charts, or technical content (explain what they represent)
- Brand names, product names, logos
Respond as plain prose, no markdown headers.`;
  return geminiMultimodal(buffer, mime, prompt);
}

async function extractAudio(buffer, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'audio/mpeg';
  const prompt = `Transcribe this audio verbatim. After the transcript, on a new line starting with "SUMMARY:", give a 2-3 sentence summary of what is discussed. Keep speaker names if you can identify them, otherwise use Speaker A/B.`;
  return geminiMultimodal(buffer, mime, prompt);
}

async function extractVideo(buffer, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'video/mp4';
  const prompt = `Process this video for a searchable knowledge base. Provide:
1. A full transcript of any spoken content (with rough timestamps in [MM:SS] format).
2. After the transcript, a "VISUAL DESCRIPTION:" section describing what is shown across the video — scenes, on-screen text, key visuals.
3. A "SUMMARY:" section with 3-4 sentences capturing the overall content.`;
  return geminiMultimodal(buffer, mime, prompt);
}

// ── Public dispatch ───────────────────────────────────────────

async function extractFile(buffer, originalName) {
  const kind = classify(originalName);
  switch (kind) {
    case 'text':  return { kind, text: await extractText(buffer) };
    case 'pdf': {
      const { text, pages } = await extractPdf(buffer);
      return { kind, text, pages };
    }
    case 'docx':  return { kind, text: await extractDocx(buffer) };
    case 'doc':   return { kind, text: await extractDoc(buffer) };
    case 'image': return { kind, text: await extractImage(buffer, originalName) };
    case 'audio': return { kind, text: await extractAudio(buffer, originalName) };
    case 'video': return { kind, text: await extractVideo(buffer, originalName) };
    default:
      throw new Error(`Unsupported file type: ${path.extname(originalName)}`);
  }
}

module.exports = { extractFile, classify };
