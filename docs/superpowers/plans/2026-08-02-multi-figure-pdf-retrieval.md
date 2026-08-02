# Multi-Figure PDF Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect, crop, caption, and directly retrieve individual figures on a PDF page (instead of one undifferentiated screenshot per page), so a question about one diagram surfaces that diagram specifically.

**Architecture:** Extend `page_images` with per-figure bounding boxes and caption embeddings. `pageImages.js`'s existing one-Gemini-call-per-page step now asks for a list of figures (caption + bounding box) instead of a yes/no, then crops each one out of the already-rendered page canvas. Retrieval gains a direct figure-caption vector search (`searchFigures`) merged with the existing page-co-location lookup, via one shared helper (`figures.js`) used by both `/retrieve` and `/study`.

**Tech Stack:** Node.js, Express, pgvector, `@napi-rs/canvas` (already a dependency), Gemini vision (`@google/generative-ai`), Gemini embeddings (`gemini-embedding-2-preview`). Tests use Node's built-in `node:test` + `node:assert` — no new dependency, since the repo has no test framework installed yet.

Full design context: `docs/superpowers/specs/2026-08-02-multi-figure-pdf-retrieval-design.md`

---

### Task 1: Add a test-runner npm script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the `test` script**

In `package.json`, in the `"scripts"` block, add:

```json
    "test": "node --test backend/",
```

(Pointing `--test` at a directory rather than a glob avoids depending on the
shell's glob-expansion behavior for `**` — npm scripts run through the OS
default shell, which isn't guaranteed to support globstar. Node's test
runner recursively finds files matching its own `*.test.js` convention
under the given directory on its own.)

So the full `scripts` block reads:

```json
  "scripts": {
    "start": "node backend/server.js",
    "dev": "node --watch backend/server.js",
    "test": "node --test backend/",
    "build": "terser public/lipsync-sdk.js -c -m -o public/lipsync-sdk.min.js --source-map",
    "build:sdk": "npm run build --workspaces --if-present",
    "postinstall": "npm run build"
  },
```

- [ ] **Step 2: Verify it runs (with no test files yet, this should report 0 tests, not error)**

Run: `npm test`
Expected: Node's test runner starts and exits cleanly (it's fine if it reports 0 tests found — later tasks add the actual `*.test.js` files it will pick up).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test: add node:test runner script"
```

---

### Task 2: Schema — bounding box + embedding columns on `page_images`

**Files:**
- Modify: `supabase/schema.sql:131-139` (the `page_images` table definition)
- Modify: `supabase/schema.sql` (end of file — schema-evolution section)
- Modify: `supabase/schema.sql:325` area (index block)

- [ ] **Step 1: Update the canonical `page_images` definition for fresh installs**

Find this block (around line 131):

```sql
CREATE TABLE IF NOT EXISTS page_images (
  id          UUID    PRIMARY KEY,
  file_id     UUID    NOT NULL REFERENCES files(id)    ON DELETE CASCADE,
  project_id  UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  image_path  TEXT    NOT NULL,
  caption     TEXT,
  created_at  BIGINT  NOT NULL
);
```

Replace it with:

```sql
CREATE TABLE IF NOT EXISTS page_images (
  id              UUID    PRIMARY KEY,
  file_id         UUID    NOT NULL REFERENCES files(id)    ON DELETE CASCADE,
  project_id      UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_number     INTEGER NOT NULL,
  image_path      TEXT    NOT NULL,
  caption         TEXT,
  -- Normalized (0-1) crop region within the full rendered page. NULL means
  -- this row is a whole-page screenshot from before per-figure cropping
  -- existed (or the model didn't return a usable box) — it's still served
  -- and displayed exactly as before, just not reachable via direct figure
  -- search (embedding is NULL too in that case).
  bbox_x          REAL,
  bbox_y          REAL,
  bbox_w          REAL,
  bbox_h          REAL,
  embedding_model TEXT,
  embedding_dim   INTEGER,
  embedding       vector(768),
  created_at      BIGINT  NOT NULL
);
```

- [ ] **Step 2: Add the HNSW index for figure-caption search**

Find the existing index line (around line 325):

```sql
CREATE INDEX IF NOT EXISTS idx_page_images_file_page     ON page_images(file_id, page_number);
```

Add directly after it:

```sql
CREATE INDEX IF NOT EXISTS idx_page_images_file_page     ON page_images(file_id, page_number);
CREATE INDEX IF NOT EXISTS idx_page_images_embedding
  ON page_images USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

- [ ] **Step 3: Add the idempotent ALTER statements for already-deployed databases**

At the end of `supabase/schema.sql`, after the existing `widget_theme` line, add:

```sql

-- multi-figure PDF retrieval: page_images gains a per-figure bounding box
-- (nullable — pre-existing rows are whole-page screenshots with no crop)
-- and a caption embedding for direct figure-level semantic search (see
-- backend/services/vector.js's searchFigures and backend/services/
-- figures.js's resolveFigures). New uploads only — existing rows are not
-- backfilled.
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS bbox_x          REAL;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS bbox_y          REAL;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS bbox_w          REAL;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS bbox_h          REAL;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS embedding_dim   INTEGER;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS embedding       vector(768);
```

- [ ] **Step 4: Apply against your database and verify**

Run: `psql "$DATABASE_URL" -f supabase/schema.sql`
Expected: no errors (every statement is `IF NOT EXISTS`, safe to re-run).

Then verify the columns exist:

Run: `psql "$DATABASE_URL" -c '\d page_images'`
Expected output includes `bbox_x`, `bbox_y`, `bbox_w`, `bbox_h`, `embedding_model`, `embedding_dim`, `embedding` columns, plus the existing ones.

- [ ] **Step 5: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: add per-figure bbox and caption embedding columns to page_images"
```

---

### Task 3: `boxToPixelRect` — bounding box conversion, with tests

**Files:**
- Modify: `backend/services/pageImages.js`
- Create: `backend/services/pageImages.test.js`

Gemini's bounding-box convention is `box_2d: [ymin, xmin, ymax, xmax]`, integers
0–1000, normalized to the full image. This step adds a pure function that
converts that into a pixel rectangle against a given page width/height,
clamping out-of-range values and rejecting degenerate boxes — before touching
anything that calls Gemini, since this part is deterministic and cheap to
test directly.

- [ ] **Step 1: Write the failing tests**

Create `backend/services/pageImages.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boxToPixelRect } = require('./pageImages');

test('boxToPixelRect converts a normal box to pixel coordinates', () => {
  const rect = boxToPixelRect([100, 200, 300, 400], 1000, 1000);
  assert.deepEqual(rect, { x: 200, y: 100, width: 200, height: 200 });
});

test('boxToPixelRect handles non-square pages', () => {
  const rect = boxToPixelRect([0, 0, 500, 1000], 800, 400);
  // ymin=0,xmin=0,ymax=500,xmax=1000 -> half height, full width
  assert.deepEqual(rect, { x: 0, y: 0, width: 800, height: 200 });
});

test('boxToPixelRect normalizes an inverted min/max box', () => {
  const inverted = boxToPixelRect([300, 400, 100, 200], 1000, 1000);
  const normal = boxToPixelRect([100, 200, 300, 400], 1000, 1000);
  assert.deepEqual(inverted, normal);
});

test('boxToPixelRect clamps out-of-range values to the page bounds', () => {
  const rect = boxToPixelRect([-50, -50, 1200, 1200], 1000, 1000);
  assert.deepEqual(rect, { x: 0, y: 0, width: 1000, height: 1000 });
});

test('boxToPixelRect returns null for a zero-size box', () => {
  assert.equal(boxToPixelRect([100, 100, 100, 500], 1000, 1000), null); // zero height
  assert.equal(boxToPixelRect([100, 100, 500, 100], 1000, 1000), null); // zero width
});

test('boxToPixelRect returns null for malformed input', () => {
  assert.equal(boxToPixelRect(null, 1000, 1000), null);
  assert.equal(boxToPixelRect([1, 2, 3], 1000, 1000), null); // wrong length
  assert.equal(boxToPixelRect([1, 2, 3, 'x'], 1000, 1000), null); // non-numeric
  assert.equal(boxToPixelRect([1, 2, 3, NaN], 1000, 1000), null); // non-finite
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test backend/services/pageImages.test.js`
Expected: FAIL — `boxToPixelRect` is not exported yet (the import will resolve to `undefined`, so calling it throws `TypeError: boxToPixelRect is not a function`).

- [ ] **Step 3: Implement `boxToPixelRect`**

In `backend/services/pageImages.js`, add this function after `retryDelayMs` (around line 39, before `classifyAndCaption`):

```javascript
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
```

At the bottom of the file, change:

```javascript
module.exports = { processPdfPageImages };
```

to:

```javascript
module.exports = { processPdfPageImages, boxToPixelRect };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test backend/services/pageImages.test.js`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add backend/services/pageImages.js backend/services/pageImages.test.js
git commit -m "feat: add boxToPixelRect for converting Gemini bounding boxes to pixel rects"
```

---

### Task 4: Replace `classifyAndCaption` with multi-figure `detectFigures`

**Files:**
- Modify: `backend/services/pageImages.js`

This changes the per-page Gemini vision call from a yes/no + single caption
into a list of figures, each with its own caption and bounding box. No unit
test here — like the rest of this codebase's Gemini-calling code (`extract.js`,
`embed.js`), it isn't mocked; this is the same untested-glue-code posture the
rest of the pipeline already has, verified manually in Task 10.

- [ ] **Step 1: Add the `MAX_FIGURES_PER_PAGE` constant**

In `backend/services/pageImages.js`, near the top where `MAX_PAGES` is defined (around line 32):

```javascript
const MAX_PAGES = parseInt(process.env.MAX_PAGE_IMAGE_PAGES || '200', 10);
```

Add directly after it:

```javascript
// Caps parsing of the vision response — a page with more than this many
// distinct figures is vanishingly rare, and it bounds worst-case crop/embed
// cost per page.
const MAX_FIGURES_PER_PAGE = parseInt(process.env.MAX_FIGURES_PER_PAGE || '6', 10);
```

- [ ] **Step 2: Replace `classifyAndCaption` with `detectFigures`**

Replace the entire `classifyAndCaption` function (currently lines 49–86, from
its doc comment through the closing brace) with:

```javascript
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
```

- [ ] **Step 3: Verify the module still loads (no syntax errors)**

Run: `node -e "require('./backend/services/pageImages.js')"`
Expected: no output, exits 0. (It will still reference `classifyAndCaption`
from `processPdfPageImages` at this point — that's fixed in Task 5. If this
command errors with `classifyAndCaption is not defined`, that's expected
until Task 5 is done; a `SyntaxError` would mean something in this step is
wrong.)

- [ ] **Step 4: Commit**

```bash
git add backend/services/pageImages.js
git commit -m "feat: detect multiple bounded figures per page instead of one yes/no classification"
```

---

### Task 5: Crop figures and rewrite `processPdfPageImages`

**Files:**
- Modify: `backend/services/pageImages.js`

- [ ] **Step 1: Hoist the `createCanvas` require and add the embed import**

At the top of `backend/services/pageImages.js`, the current imports are:

```javascript
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../db');
const logger = require('../logger').child({ module: 'services/pageImages' });
```

Replace with:

```javascript
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { createCanvas } = require('@napi-rs/canvas');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../db');
const { embedMany, MODEL: EMBED_MODEL, OUTPUT_DIM: EMBED_DIM } = require('./embed');
const logger = require('../logger').child({ module: 'services/pageImages' });
```

(`createCanvas` was previously required inline inside `processPdfPageImages`
— it's needed at module scope now since a new `cropFigure` helper also uses
it.)

- [ ] **Step 2: Add the `cropFigure` helper**

Add this function directly after `boxToPixelRect` (from Task 3):

```javascript
/** Blits a sub-rectangle of an already-rendered page canvas onto a new,
 * rect-sized canvas — no PNG re-decoding needed, it's a canvas-to-canvas
 * copy. */
function cropFigure(sourceCanvas, rect) {
  const dest = createCanvas(rect.width, rect.height);
  const ctx = dest.getContext('2d');
  ctx.drawImage(sourceCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return dest;
}
```

- [ ] **Step 3: Rewrite `processPdfPageImages`**

Replace the entire `processPdfPageImages` function (from its doc comment
through the closing brace, just above `module.exports`) with:

```javascript
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
```

- [ ] **Step 4: Verify the module loads cleanly**

Run: `node -e "require('./backend/services/pageImages.js')"`
Expected: no output, exits 0.

- [ ] **Step 5: Run the full pageImages test file to confirm no regression**

Run: `node --test backend/services/pageImages.test.js`
Expected: PASS — same 7 tests from Task 3, still passing.

- [ ] **Step 6: Commit**

```bash
git add backend/services/pageImages.js
git commit -m "feat: crop and persist multiple figures per page with batched caption embeddings"
```

---

### Task 6: `searchFigures` — direct figure-caption vector search

**Files:**
- Modify: `backend/services/vector.js`

- [ ] **Step 1: Add `searchFigures` alongside the existing `searchProject`**

In `backend/services/vector.js`, the file currently ends with:

```javascript
module.exports = { searchProject };
```

Replace the whole file's tail — insert this new function before the
`module.exports` line, and update the export:

```javascript
/**
 * Find the top-K page_images whose caption embedding is closest to the
 * query embedding, within a project. Used for direct figure-level matches
 * ("show me the alternator") independent of which text chunk matched —
 * see backend/services/figures.js for how this merges with page
 * co-location. Rows without an embedding (pre-existing whole-page
 * screenshots, or figures whose caption embedding failed) are excluded via
 * the IS NOT NULL filter, same pattern as searchProject's chunks.
 */
async function searchFigures(projectId, queryEmbedding, k = 4) {
  const vectorStr = '[' + queryEmbedding.join(',') + ']';
  const rows = await db.query(
    `SELECT id, project_id, file_id, page_number, image_path, caption,
            1 - (embedding <=> $1::vector) AS score
     FROM page_images
     WHERE project_id = $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorStr, projectId, k]
  );
  return rows.map(r => ({ figure: r, score: typeof r.score === 'number' ? r.score : parseFloat(r.score) }));
}

module.exports = { searchProject, searchFigures };
```

- [ ] **Step 2: Verify the module loads cleanly**

Run: `node -e "require('./backend/services/vector.js')"`
Expected: no output, exits 0.

- [ ] **Step 3: Commit**

```bash
git add backend/services/vector.js
git commit -m "feat: add searchFigures for direct figure-caption vector search"
```

---

### Task 7: `figures.js` — merge direct matches with page co-location

**Files:**
- Create: `backend/services/figures.js`
- Create: `backend/services/figures.test.js`

The merge/dedupe logic is pure (no I/O) and is split out from the async
DB-calling wrapper specifically so it can be unit-tested with synthetic
fixtures, per the design doc's testing plan.

- [ ] **Step 1: Write the failing tests**

Create `backend/services/figures.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeFigures } = require('./figures');

function fig(id, overrides = {}) {
  return { id, fileId: 'file-1', pageNumber: 1, imagePath: `/x/${id}.png`, caption: `caption ${id}`, ...overrides };
}

test('mergeFigures ranks direct matches above co-located ones', () => {
  const direct = [{ figure: fig('a'), score: 0.9 }];
  const pageImageCache = new Map([['file-1:2', [fig('b')]]]);
  const hits = [{ chunk: { fileId: 'file-1', pageHint: 2 }, score: 0.99 }];

  const result = mergeFigures({ directHits: direct, pageImageCache, hits, threshold: 0.5, cap: 10 });
  assert.deepEqual(result.map(f => f.id), ['a', 'b']);
});

test('mergeFigures drops direct matches below the threshold', () => {
  const direct = [{ figure: fig('a'), score: 0.2 }];
  const result = mergeFigures({ directHits: direct, pageImageCache: new Map(), hits: [], threshold: 0.5, cap: 10 });
  assert.deepEqual(result, []);
});

test('mergeFigures dedupes a figure that is both a direct match and co-located', () => {
  const direct = [{ figure: fig('a'), score: 0.9 }];
  const pageImageCache = new Map([['file-1:1', [fig('a')]]]);
  const hits = [{ chunk: { fileId: 'file-1', pageHint: 1 }, score: 0.99 }];

  const result = mergeFigures({ directHits: direct, pageImageCache, hits, threshold: 0.5, cap: 10 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'a');
});

test('mergeFigures includes all co-located figures for a matched page, not just one', () => {
  const pageImageCache = new Map([['file-1:1', [fig('a'), fig('b'), fig('c')]]]);
  const hits = [{ chunk: { fileId: 'file-1', pageHint: 1 }, score: 0.8 }];

  const result = mergeFigures({ directHits: [], pageImageCache, hits, threshold: 0.5, cap: 10 });
  assert.deepEqual(new Set(result.map(f => f.id)), new Set(['a', 'b', 'c']));
});

test('mergeFigures caps the total number of results', () => {
  const pageImageCache = new Map([['file-1:1', [fig('a'), fig('b'), fig('c')]]]);
  const hits = [{ chunk: { fileId: 'file-1', pageHint: 1 }, score: 0.8 }];

  const result = mergeFigures({ directHits: [], pageImageCache, hits, threshold: 0.5, cap: 2 });
  assert.equal(result.length, 2);
});

test('mergeFigures returns an empty array when nothing matches', () => {
  const result = mergeFigures({ directHits: [], pageImageCache: new Map(), hits: [], threshold: 0.5, cap: 10 });
  assert.deepEqual(result, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test backend/services/figures.test.js`
Expected: FAIL — `backend/services/figures.js` does not exist yet
(`Cannot find module './figures'`).

- [ ] **Step 3: Implement `backend/services/figures.js`**

Create `backend/services/figures.js`:

```javascript
/**
 * Resolves the figures[] array returned to chat/retrieval callers, merging
 * two sources of relevant figures:
 *
 *   1. Direct caption match — the query embedding searched directly against
 *      figure caption embeddings (searchFigures in vector.js). This is what
 *      lets "show me the alternator" find the alternator crop specifically,
 *      even among several figures on the same page.
 *   2. Page co-location — every figure on the page of a retrieved text
 *      chunk (the pre-existing behavior, generalized to multiple figures
 *      per page instead of at most one).
 *
 * Used by both POST /embed/:publicId/retrieve and POST /embed/:publicId/study
 * so the merge logic isn't duplicated across routes.
 */
const { searchFigures } = require('./vector');

const FIGURE_MATCH_THRESHOLD = parseFloat(process.env.FIGURE_MATCH_THRESHOLD || '0.5');
const MAX_FIGURES_PER_ANSWER = parseInt(process.env.MAX_FIGURES_PER_ANSWER || '4', 10);

/**
 * Pure merge/dedupe/rank step, split out from resolveFigures so it can be
 * unit-tested without a database.
 *
 * @param {Array<{figure: object, score: number}>} directHits - searchFigures() results
 * @param {Map<string, object[]>} pageImageCache - "fileId:pageNumber" -> figure rows
 * @param {Array<{chunk: {fileId, pageHint}, score: number}>} hits - searchProject() results
 * @param {number} threshold - minimum score for a direct hit to count
 * @param {number} cap - maximum number of figures to return
 * @returns {object[]} figure rows, direct matches first, then by score, deduped by id
 */
function mergeFigures({ directHits, pageImageCache, hits, threshold, cap }) {
  const byId = new Map();

  for (const { figure, score } of directHits) {
    if (score < threshold) continue;
    byId.set(figure.id, { figure, score, direct: true });
  }

  for (const hit of hits) {
    const key = `${hit.chunk.fileId}:${hit.chunk.pageHint}`;
    const coLocated = pageImageCache.get(key) || [];
    for (const figure of coLocated) {
      if (!byId.has(figure.id)) byId.set(figure.id, { figure, score: hit.score, direct: false });
    }
  }

  return [...byId.values()]
    .sort((a, b) => (b.direct - a.direct) || (b.score - a.score))
    .slice(0, cap)
    .map(v => v.figure);
}

/**
 * Runs the direct figure search and merges it with the caller's already-
 * computed page co-location cache, returning API-shaped figure objects.
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {number[]} args.queryEmbedding
 * @param {Array<{chunk: {fileId, pageHint}, score: number}>} args.hits - searchProject() results
 * @param {Map<string, object[]>} args.pageImageCache - from pageImagesForHits()
 * @param {string} args.publicId - project's public id, for building URLs
 * @param {Map<string, object>} args.fileCache - fileId -> file row, from filesForHits()
 */
async function resolveFigures({ projectId, queryEmbedding, hits, pageImageCache, publicId, fileCache }) {
  const directHits = await searchFigures(projectId, queryEmbedding, MAX_FIGURES_PER_ANSWER);
  const merged = mergeFigures({ directHits, pageImageCache, hits, threshold: FIGURE_MATCH_THRESHOLD, cap: MAX_FIGURES_PER_ANSWER });

  return merged.map(figure => {
    const file = fileCache.get(figure.fileId);
    return {
      pageImageUrl: `/embed/${publicId}/page-image/${figure.id}`,
      caption: figure.caption,
      fileName: file ? file.originalName : null,
      pdfUrl: file && file.kind === 'pdf' ? `/embed/${publicId}/file/${file.id}` : null,
      pdfPage: figure.pageNumber,
    };
  });
}

module.exports = { resolveFigures, mergeFigures, FIGURE_MATCH_THRESHOLD, MAX_FIGURES_PER_ANSWER };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test backend/services/figures.test.js`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add backend/services/figures.js backend/services/figures.test.js
git commit -m "feat: add figures.js to merge direct caption matches with page co-location"
```

---

### Task 8: Wire the routes — `pageImagesForHits` grouping + `/retrieve` + `/study`

**Files:**
- Modify: `backend/routes/embed.js:1-53` (imports + `pageImagesForHits`)
- Modify: `backend/routes/embed.js:122-171` (`/retrieve` route)
- Modify: `backend/routes/embed.js:350-383` (`/study` route's figures section)

- [ ] **Step 1: Import `resolveFigures`**

At the top of `backend/routes/embed.js`, find:

```javascript
const { embedOne } = require('../services/embed');
const { searchProject } = require('../services/vector');
```

Replace with:

```javascript
const { embedOne } = require('../services/embed');
const { searchProject } = require('../services/vector');
const { resolveFigures } = require('../services/figures');
```

- [ ] **Step 2: Update `pageImagesForHits` to group multiple figures per page**

Replace the current function:

```javascript
async function pageImagesForHits(hits) {
  const fileIds = [...new Set(hits.map(h => h.chunk.fileId).filter(Boolean))];
  if (!fileIds.length) return new Map();
  const rows = await db.query('SELECT * FROM page_images WHERE file_id = ANY($1::uuid[])', [fileIds]);
  return new Map(rows.map(r => [`${r.fileId}:${r.pageNumber}`, r]));
}
```

with:

```javascript
/**
 * Fetch page_images for a set of chunk hits in one round trip. Keyed by
 * "fileId:pageNumber" (chunks.page_hint is accurate — see chunk.js), mapped
 * to an ARRAY of figure rows since a page can now have zero, one, or
 * several distinct figures (see backend/services/pageImages.js).
 */
async function pageImagesForHits(hits) {
  const fileIds = [...new Set(hits.map(h => h.chunk.fileId).filter(Boolean))];
  if (!fileIds.length) return new Map();
  const rows = await db.query('SELECT * FROM page_images WHERE file_id = ANY($1::uuid[])', [fileIds]);
  const map = new Map();
  for (const r of rows) {
    const key = `${r.fileId}:${r.pageNumber}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}
```

- [ ] **Step 3: Simplify the `/retrieve` route's `chunks[]` and add top-level `figures[]`**

Replace:

```javascript
  const hits = await searchProject(project.id, queryEmbedding, Math.min(Math.max(1, k), 10));

  const fileCache = await filesForHits(hits);
  const showFigures = project.capabilityTier !== 'basic';
  const pageImageCache = showFigures ? await pageImagesForHits(hits) : new Map();
  const sources = [];
  const chunks = [];
  for (const hit of hits) {
    const file = fileCache.get(hit.chunk.fileId);
    const pageImage = showFigures ? pageImageCache.get(`${hit.chunk.fileId}:${hit.chunk.pageHint}`) : null;
    chunks.push({
      text: hit.chunk.text,
      score: hit.score,
      fileId: hit.chunk.fileId,
      fileName: file ? file.originalName : null,
      kind: file ? file.kind : null,
      pageImageUrl: pageImage ? `/embed/${project.publicId}/page-image/${pageImage.id}` : null,
      pageImageCaption: pageImage ? pageImage.caption : null,
      pdfUrl: (showFigures && file && file.kind === 'pdf') ? `/embed/${project.publicId}/file/${file.id}` : null,
      pdfPage: hit.chunk.pageHint || null,
    });
    if (file && !sources.find(s => s.fileId === file.id)) {
      sources.push({
        fileId: file.id,
        fileName: file.originalName,
        kind: file.kind,
        previewUrl: file.kind === 'image'
          ? `/embed/${project.publicId}/file/${file.id}`
          : null,
      });
    }
  }

  res.json({ chunks, sources });
});
```

with:

```javascript
  const hits = await searchProject(project.id, queryEmbedding, Math.min(Math.max(1, k), 10));

  const fileCache = await filesForHits(hits);
  const showFigures = project.capabilityTier !== 'basic';
  const pageImageCache = showFigures ? await pageImagesForHits(hits) : new Map();
  const sources = [];
  const chunks = [];
  for (const hit of hits) {
    const file = fileCache.get(hit.chunk.fileId);
    chunks.push({
      text: hit.chunk.text,
      score: hit.score,
      fileId: hit.chunk.fileId,
      fileName: file ? file.originalName : null,
      kind: file ? file.kind : null,
    });
    if (file && !sources.find(s => s.fileId === file.id)) {
      sources.push({
        fileId: file.id,
        fileName: file.originalName,
        kind: file.kind,
        previewUrl: file.kind === 'image'
          ? `/embed/${project.publicId}/file/${file.id}`
          : null,
      });
    }
  }

  const figures = showFigures
    ? await resolveFigures({ projectId: project.id, queryEmbedding, hits, pageImageCache, publicId: project.publicId, fileCache })
    : [];

  res.json({ chunks, sources, figures });
});
```

(Per-chunk `pageImageUrl`/`pageImageCaption`/`pdfUrl`/`pdfPage` fields are
removed — `public/embed.html` was the only consumer, and it derived a
deduped figure list from them client-side; that logic moves server-side into
`resolveFigures` and is updated in Task 9.)

- [ ] **Step 4: Replace the `/study` route's per-chunk figure-building with `resolveFigures`**

Replace:

```javascript
    const hits = await searchProject(project.id, queryEmbedding, 5);
    const fileCache = await filesForHits(hits);
    // capabilityTier !== 'basic' already enforced above to even reach this route.
    const pageImageCache = await pageImagesForHits(hits);
    const sources = [];
    const figures = [];
    const contextParts = [];

    for (const hit of hits) {
      const file = fileCache.get(hit.chunk.fileId);
      contextParts.push(`[Source: ${file ? file.originalName : 'Unknown'}]\n${hit.chunk.text}`);
      // Same shape as /retrieve's sources — embed.html's attachSources() renders both identically.
      if (file && !sources.find(s => s.fileId === file.id)) {
        sources.push({
          fileId: file.id,
          fileName: file.originalName,
          kind: file.kind,
          previewUrl: file.kind === 'image'
            ? `/embed/${project.publicId}/file/${file.id}`
            : null,
        });
      }

      const pageImage = pageImageCache.get(`${hit.chunk.fileId}:${hit.chunk.pageHint}`);
      if (pageImage && !figures.find(f => f.pageImageUrl === `/embed/${project.publicId}/page-image/${pageImage.id}`)) {
        figures.push({
          pageImageUrl: `/embed/${project.publicId}/page-image/${pageImage.id}`,
          caption: pageImage.caption,
          fileName: file ? file.originalName : null,
          pdfUrl: file && file.kind === 'pdf' ? `/embed/${project.publicId}/file/${file.id}` : null,
          pdfPage: hit.chunk.pageHint || null,
        });
      }
    }
```

with:

```javascript
    const hits = await searchProject(project.id, queryEmbedding, 5);
    const fileCache = await filesForHits(hits);
    // capabilityTier !== 'basic' already enforced above to even reach this route.
    const pageImageCache = await pageImagesForHits(hits);
    const sources = [];
    const contextParts = [];

    for (const hit of hits) {
      const file = fileCache.get(hit.chunk.fileId);
      contextParts.push(`[Source: ${file ? file.originalName : 'Unknown'}]\n${hit.chunk.text}`);
      // Same shape as /retrieve's sources — embed.html's attachSources() renders both identically.
      if (file && !sources.find(s => s.fileId === file.id)) {
        sources.push({
          fileId: file.id,
          fileName: file.originalName,
          kind: file.kind,
          previewUrl: file.kind === 'image'
            ? `/embed/${project.publicId}/file/${file.id}`
            : null,
        });
      }
    }

    const figures = await resolveFigures({ projectId: project.id, queryEmbedding, hits, pageImageCache, publicId: project.publicId, fileCache });
```

The rest of the route (building `contextText`, the Gemini function-calling
loop, and `res.json({ answer, toolCalls, sources, figures, sessionId: sid })`)
is unchanged — `figures` is still in scope with the same shape as before.

- [ ] **Step 5: Verify the module loads cleanly**

Run: `node -e "require('./backend/routes/embed.js')"`
Expected: no output, exits 0.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/embed.js
git commit -m "feat: merge direct figure matches with page co-location in /retrieve and /study"
```

---

### Task 9: Frontend — consume the new top-level `figures[]`

**Files:**
- Modify: `public/embed.html:431-436`

- [ ] **Step 1: Simplify figure derivation to use the server-computed array**

Find (around line 431):

```javascript
    pendingSources = (config.project.showSourceCards !== false) ? retrieved.sources : null;

    const seenPageImages = new Set();
    pendingFigures = retrieved.chunks
      .filter(c => c.pageImageUrl && !seenPageImages.has(c.pageImageUrl) && seenPageImages.add(c.pageImageUrl))
      .map(c => ({ pageImageUrl: c.pageImageUrl, caption: c.pageImageCaption, fileName: c.fileName, pdfUrl: c.pdfUrl, pdfPage: c.pdfPage }));
```

Replace with:

```javascript
    pendingSources = (config.project.showSourceCards !== false) ? retrieved.sources : null;
    pendingFigures = retrieved.figures || [];
```

(The dedup-by-URL logic that used to live here now happens server-side in
`mergeFigures`'s dedupe-by-id step, and the field mapping is unnecessary
since `resolveFigures` already returns exactly this shape:
`{ pageImageUrl, caption, fileName, pdfUrl, pdfPage }`.)

- [ ] **Step 2: Update the default value at the top of `sendMessage`**

Find (around line 415):

```javascript
    let retrieved = { chunks: [], sources: [] };
```

Replace with:

```javascript
    let retrieved = { chunks: [], sources: [], figures: [] };
```

(So a failed `/retrieve` call — the `catch` block a few lines below already
handles this — still leaves `retrieved.figures` as an array rather than
`undefined`, since Step 1 no longer has a fallback of its own.)

- [ ] **Step 3: Manual smoke check**

Run: `node -e "require('fs').readFileSync('public/embed.html','utf8')"` to
confirm the file still parses as valid text (this is HTML, not JS, so there's
no syntax check beyond opening it) — then open `public/embed.html` in a
browser against a running dev server (see Task 10) and send a message in a
project with an indexed PDF; confirm no console errors about `retrieved.chunks`
or undefined figure fields.

- [ ] **Step 4: Commit**

```bash
git add public/embed.html
git commit -m "feat: consume server-computed figures[] directly in the embed widget"
```

---

### Task 10: End-to-end verification

**Files:** none (manual verification only)

This pipeline calls real external services (Gemini vision, Gemini
embeddings) and needs a real multi-figure PDF, so it isn't automated — same
posture as the rest of this codebase's Gemini-calling paths.

- [ ] **Step 1: Start the server**

Run: `npm run dev`
Expected: server starts without errors, logs show it listening on its
configured port.

- [ ] **Step 2: Upload a PDF with at least one page containing 2+ distinct diagrams**

Through the project dashboard (`public/project.html`), upload such a PDF to
a project on the Medium or Advanced capability tier (page images require
`capabilityTier !== 'basic'`). Watch the server logs for
`"page image processing done"`.

- [ ] **Step 3: Confirm multiple distinct crops were created**

Run: `psql "$DATABASE_URL" -c "SELECT page_number, caption, bbox_x, bbox_y, bbox_w, bbox_h, embedding IS NOT NULL AS has_embedding FROM page_images WHERE file_id = '<the uploaded file id>' ORDER BY page_number;"`
Expected: multiple rows for the page with 2+ diagrams, each with distinct
`bbox_*` values, non-null captions, and `has_embedding = true`.

- [ ] **Step 4: Confirm targeted retrieval finds the specific figure**

Open the project's embed widget, ask a question naming one of the specific
diagrams (e.g. "show me the alternator" if that's what one of the figures
depicts). Confirm the figure card shown is the cropped image of that
specific diagram — not the whole page, and not an unrelated figure from the
same page.

- [ ] **Step 5: Regression check — pre-existing whole-page rows still work**

Find a `page_images` row from before this change (created via
`processPdfPageImages` prior to this plan — `bbox_x IS NULL`). Ask a
question whose matching text chunk is on that row's page. Confirm the
whole-page screenshot still renders correctly in the chat (through
`/embed/:publicId/page-image/:pageImageId`, unchanged route) even though it
has no bounding box or embedding — it should surface via page co-location in
`mergeFigures`, not direct match.

- [ ] **Step 6: Run the full test suite one more time**

Run: `npm test`
Expected: all tests pass (Task 3's 7 tests + Task 7's 6 tests, 13 total).
