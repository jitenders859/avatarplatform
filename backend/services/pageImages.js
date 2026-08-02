/**
 * PDF page rasterization + Gemini vision figure detection/cropping.
 *
 * For each page: render the full page to PNG (pdfjs-dist + @napi-rs/canvas
 * — chosen over node-canvas because it ships prebuilt binaries, no system
 * Cairo needed, which matters for arbitrary Node hosts like Railway/Render/
 * Fly.io), then ask Gemini vision to identify every distinct diagram,
 * chart, or other meaningful figure on the page along with a bounding box
 * and caption for each. Each detected figure is cropped out of the
 * already-rendered page canvas and persisted as its own image + DB row —
 * a single page can yield zero, one, or several figure rows. A wall of
 * plain text with no figures yields none.
 *
 * The page is still rendered in full before cropping (rather than trying
 * to extract only embedded raster images) because many diagrams/charts in
 * real documents are vector-drawn directly in the PDF content stream, not
 * embedded as raster images, so "extract embedded images" alone would miss
 * them entirely. Painting the whole page as pixels first, then cropping to
 * each figure's bounding box, captures both cases.
 *
 * pdfjs-dist ships ESM-only (no CJS build) — loaded via dynamic import()
 * from this otherwise-CommonJS module, the standard way to consume an
 * ESM-only package from CJS without converting the whole project.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { createCanvas } = require('@napi-rs/canvas');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../db');
const { embedMany, MODEL: EMBED_MODEL, OUTPUT_DIM: EMBED_DIM } = require('./embed');
const logger = require('../logger').child({ module: 'services/pageImages' });

const PAGE_CLASSIFY_MODEL = process.env.PAGE_CLASSIFY_MODEL || 'gemini-3.5-flash';
const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'data', 'uploads');
// Cap per-document cost/latency — one Gemini vision call per page.
const MAX_PAGES = parseInt(process.env.MAX_PAGE_IMAGE_PAGES || '200', 10);
// Caps parsing of the vision response — a page with more than this many
// distinct figures is vanishingly rare, and it bounds worst-case crop/embed
// cost per page.
const MAX_FIGURES_PER_PAGE = parseInt(process.env.MAX_FIGURES_PER_PAGE || '6', 10);

/** Pulls the server-recommended wait out of a 429's structured RetryInfo, if present. */
function retryDelayMs(err) {
  const info = (err.errorDetails || []).find(d => d['@type']?.includes('RetryInfo'));
  const match = info?.retryDelay?.match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

/**
 * Converts a Gemini box_2d [ymin, xmin, ymax, xmax] (integers 0-1000,
 * normalized to the full page image) into a pixel rect { x, y, width,
 * height } clamped to the page bounds. Returns null for malformed or
 * degenerate (zero-size) boxes so callers can skip them without
 * special-casing bad model output at every call site.
 */
function boxToPixelRect(box2d, pageWidth, pageHeight) {
  if (!Array.isArray(box2d) || box2d.length !== 4 || box2d.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
    return null;
  }
  const [yminRaw, xminRaw, ymaxRaw, xmaxRaw] = box2d;
  const clamp = n => Math.max(0, Math.min(1000, n));
  const ymin = clamp(Math.min(yminRaw, ymaxRaw));
  const ymax = clamp(Math.max(yminRaw, ymaxRaw));
  const xmin = clamp(Math.min(xminRaw, xmaxRaw));
  const xmax = clamp(Math.max(xminRaw, xmaxRaw));

  const x = Math.round((xmin / 1000) * pageWidth);
  const y = Math.round((ymin / 1000) * pageHeight);
  const width = Math.round(((xmax - xmin) / 1000) * pageWidth);
  const height = Math.round(((ymax - ymin) / 1000) * pageHeight);

  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** Blits a sub-rectangle of an already-rendered page canvas onto a new,
 * rect-sized canvas — no PNG re-decoding needed, it's a canvas-to-canvas
 * copy. */
function cropFigure(sourceCanvas, rect) {
  const dest = createCanvas(rect.width, rect.height);
  const ctx = dest.getContext('2d');
  ctx.drawImage(sourceCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return dest;
}

/**
 * Free-tier Gemini quotas for vision models are tight enough to hit in
 * normal use (empirically: 5 requests/minute and 20/day on gemini-3.5-flash
 * during testing) — a per-page classification loop WILL hit 429s on any
 * document longer than a few pages, so this isn't an edge case to shrug
 * off. Retries with the server's own suggested delay when given, since
 * that's more precise than blind exponential backoff for quota errors.
 */
async function detectFigures(pngBuffer) {
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({
    model: PAGE_CLASSIFY_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          figures: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                caption: { type: 'string' },
                box_2d: { type: 'array', items: { type: 'integer' } },
              },
              required: ['caption', 'box_2d'],
            },
          },
        },
        required: ['figures'],
      },
    },
  });
  const prompt =
    'Identify every distinct diagram, chart, technical illustration, table, or other meaningful ' +
    'visual figure on this page — as opposed to plain paragraph text. Treat each separate figure as ' +
    'its own entry, even if several appear on the same page; do not merge unrelated figures into one ' +
    'box. For each, provide a one-sentence caption describing what it shows and a bounding box as ' +
    'box_2d: [ymin, xmin, ymax, xmax] with integers 0-1000 relative to the full page image. If the ' +
    'page has no meaningful figures, return an empty figures array.';
  const parts = [
    { inlineData: { mimeType: 'image/png', data: pngBuffer.toString('base64') } },
    { text: prompt },
  ];

  let attempt = 0;
  while (true) {
    try {
      const result = await model.generateContent(parts);
      const parsed = JSON.parse(result.response.text());
      return Array.isArray(parsed.figures) ? parsed.figures.slice(0, MAX_FIGURES_PER_PAGE) : [];
    } catch (e) {
      if (e.status !== 429 || attempt >= 4) throw e;
      const wait = retryDelayMs(e) ?? 500 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
    }
  }
}

/**
 * Renders every page of a PDF, detects figures on each via Gemini vision,
 * crops and persists each qualifying figure as its own image + DB row, and
 * embeds every figure's caption in one batched call per file. Returns a Map
 * of pageNumber -> array of page_images row ids, for logging/diagnostics
 * (retrieval itself queries page_images directly — see vector.js and
 * routes/embed.js — rather than using this return value).
 */
async function processPdfPageImages(pdfPath, fileId, projectId, numPages) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const pdfBuffer = await fs.promises.readFile(pdfPath);
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer), disableWorker: true }).promise;
  const pageCount = Math.min(numPages, MAX_PAGES);
  const outDir = path.join(UPLOAD_ROOT, projectId, 'pages', fileId);
  // Clear any prior run's figures for this file — reindex/reprocess would
  // otherwise APPEND a full duplicate set of rows and crop files on top of
  // the old ones every time, rather than replacing them (chunks already
  // get this treatment via db.remove('chunks', { fileId }) in process.js;
  // this mirrors that for page_images).
  await fs.promises.rm(outDir, { recursive: true, force: true }).catch(() => {});
  await db.remove('pageImages', { fileId }).catch(() => {});
  await fs.promises.mkdir(outDir, { recursive: true });

  const pending = []; // { pageNumber, imagePath, caption, bbox: {x,y,w,h} normalized 0-1
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    try {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const png = await canvas.encode('png');

      const figures = await detectFigures(png);
      let figureIndex = 0;
      for (const fig of figures) {
        try {
          const rect = boxToPixelRect(fig.box_2d, viewport.width, viewport.height);
          if (!rect) {
            logger.warn({ fileId, pageNumber, box2d: fig.box_2d }, 'skipping figure with invalid bounding box');
            continue;
          }
          const cropCanvas = cropFigure(canvas, rect);
          const cropPng = await cropCanvas.encode('png');
          const imagePath = path.join(outDir, `page-${pageNumber}-fig-${figureIndex}.png`);
          await fs.promises.writeFile(imagePath, cropPng);
          pending.push({
            pageNumber,
            imagePath,
            caption: (fig.caption || '').trim() || null,
            bbox: {
              x: rect.x / viewport.width,
              y: rect.y / viewport.height,
              w: rect.width / viewport.width,
              h: rect.height / viewport.height,
            },
          });
          figureIndex++;
        } catch (e) {
          logger.warn({ fileId, pageNumber, figureIndex, err: e.message }, 'figure crop/write failed, skipping figure');
        }
      }
    } catch (e) {
      logger.warn({ fileId, pageNumber, err: e.message }, 'page image processing failed, skipping page');
    }
  }

  if (!pending.length) return new Map();

  // Batch-embed every figure caption for this file in one call. A batch
  // failure still leaves figures persisted (without embeddings) rather than
  // dropping them — they degrade to page-co-location-only reachability,
  // matching this pipeline's "never fail the file over an enhancement"
  // posture (see process.js's try/catch around this whole function).
  let embeddings = [];
  try {
    const captionsForEmbedding = pending.map(p => p.caption || '(untitled figure)');
    embeddings = await embedMany(captionsForEmbedding, 'RETRIEVAL_DOCUMENT');
  } catch (e) {
    logger.warn({ fileId, err: e.message }, 'figure caption embedding failed, figures stored without embeddings');
  }

  const rows = pending.map((p, i) => ({
    id:             uuid(),
    fileId,
    projectId,
    pageNumber:     p.pageNumber,
    imagePath:      p.imagePath,
    caption:        p.caption,
    bboxX:          p.bbox.x,
    bboxY:          p.bbox.y,
    bboxW:          p.bbox.w,
    bboxH:          p.bbox.h,
    embeddingModel: embeddings[i] ? EMBED_MODEL : null,
    embeddingDim:   embeddings[i] ? EMBED_DIM : null,
    embedding:      embeddings[i] || null,
    createdAt:      Date.now(),
  }));
  const inserted = await db.insertMany('pageImages', rows);

  const pageImageIdByNumber = new Map();
  for (const row of inserted) {
    if (!pageImageIdByNumber.has(row.pageNumber)) pageImageIdByNumber.set(row.pageNumber, []);
    pageImageIdByNumber.get(row.pageNumber).push(row.id);
  }
  return pageImageIdByNumber;
}

module.exports = { processPdfPageImages, boxToPixelRect };
