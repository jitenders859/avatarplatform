# Multi-Figure PDF Retrieval — Design

## Context

The knowledge-base pipeline already extracts PDF text, chunks it, embeds it with
`gemini-embedding-2-preview`, and stores it in pgvector (`backend/services/extract.js`,
`chunk.js`, `embed.js`, `process.js`). It also has a page-image pipeline
(`backend/services/pageImages.js`) that rasterizes each PDF page, asks Gemini
vision a yes/no question ("does this page contain a figure?"), and stores at
most **one screenshot per page**. Chat retrieval (`backend/routes/embed.js`)
joins matched text chunks to their page's screenshot and returns a `figures[]`
array that the embed widget (`public/embed.html`) already renders as cards
with a caption, a lightbox, and a link back to the source PDF page.

The gap: a page with several distinct diagrams currently returns one
undifferentiated screenshot of the whole page. A user asking "show me the
alternator" gets the same image as someone asking about anything else on that
page. This design extends the pipeline to detect, crop, caption, and directly
retrieve **individual figures**, not just pages.

Deliberately out of scope (see "Explicitly excluded" below): true embedded-
raster image extraction, OCR, WebP compression, dedup hashing, figure-number
regex matching ("Fig. 3"), and any change of stack (Flutter/FastAPI/Python
tooling, alternate vector DBs). This is an extension of the existing Node/
Express/pgvector/Gemini pipeline, not a rebuild.

## Data model

Extend the existing `page_images` table in place — no rename, no data
migration:

```sql
ALTER TABLE page_images
  ADD COLUMN bbox_x          REAL,
  ADD COLUMN bbox_y          REAL,
  ADD COLUMN bbox_w          REAL,
  ADD COLUMN bbox_h          REAL,
  ADD COLUMN embedding_model TEXT,
  ADD COLUMN embedding_dim   INTEGER,
  ADD COLUMN embedding       vector(768);
```

- `bbox_*` are normalized (0–1) coordinates of the crop within the full
  rendered page, nullable.
- `embedding` is the vector for the figure's caption text, nullable.
- Rows created before this change keep `bbox_*`/`embedding` as `NULL` and
  continue to behave exactly as they do today (whole-page image, no direct
  caption search, only reachable via page co-location). No backfill job is
  built — this only applies to newly processed PDFs.
- A page can now have zero, one, or several `page_images` rows instead of at
  most one.

## Detection & cropping pipeline (`backend/services/pageImages.js`)

Per page, the render step is unchanged (pdfjs-dist → `@napi-rs/canvas`,
scale 1.5). What changes is the Gemini vision call and what happens with its
result:

1. **Prompt/schema change.** Replace the `{hasFigure, caption}` schema with a
   list schema, capped at a small max (`MAX_FIGURES_PER_PAGE`, default 6, env-
   overridable like the existing `MAX_PAGE_IMAGE_PAGES`):

   ```json
   {
     "figures": [
       { "caption": "Fuel selector valve, shown mounted beneath the console",
         "box_2d": [ymin, xmin, ymax, xmax] }
     ]
   }
   ```

   `box_2d` uses Gemini's own documented bounding-box convention (integers
   0–1000, `[ymin, xmin, ymax, xmax]`) rather than an invented format —
   that's the convention these models are actually trained to emit reliably.
   An empty `figures` array is valid (page has no meaningful visual content)
   and results in zero rows, same as `hasFigure: false` today.

2. **Crop.** For each detected figure, convert its `box_2d` to pixel
   coordinates against the rendered canvas's width/height, then use
   `ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh)` on a
   freshly-created destination canvas sized to the crop — no PNG
   re-decoding needed, it's a canvas-to-canvas blit. Encode and save as
   `page-{pageNumber}-fig-{i}.png` in the same per-file output directory
   used today.

3. **Caption embeddings.** After all pages of a file are processed, batch-
   embed every collected caption in one `embedMany(captions,
   'RETRIEVAL_DOCUMENT')` call (reusing `backend/services/embed.js`) and
   attach each resulting vector to its row before insert. If embedding
   fails for the batch, figures still get stored — they just remain
   reachable only through page co-location (same degraded-but-functional
   behavior as an old-format row), matching this pipeline's existing
   "never fail the whole file over a page-image enhancement" posture
   (`process.js`'s try/catch around `processPdfPageImages`).

4. **Retry/quota handling.** Unchanged — same 429 backoff logic
   (`classifyAndCaption`'s retry loop) applies to the renamed/expanded
   vision call. Call volume is identical to today (one vision call per
   page); the only new API cost is the batched caption-embedding call per
   file.

## Retrieval (`backend/services/vector.js`, `backend/routes/embed.js`)

Two paths that feed into the same `figures[]` output, merged and deduped by
figure id:

1. **Page co-location (generalized).** `pageImagesForHits()` currently does
   `SELECT * FROM page_images WHERE file_id = ANY($1)` and keys results as
   `fileId:pageNumber -> single row`. It changes to key as `fileId:pageNumber
   -> array of rows`, since a page can now have multiple figures. Every
   figure on a matched chunk's page is now a candidate (previously only one
   could exist).

2. **Direct caption match (new).** A new `searchFigures(projectId,
   queryEmbedding, k)` in `vector.js`, mirroring `searchProject()`:

   ```sql
   SELECT id, file_id, page_number, image_path, caption,
          1 - (embedding <=> $1::vector) AS score
   FROM page_images
   WHERE project_id = $2 AND embedding IS NOT NULL
   ORDER BY embedding <=> $1::vector
   LIMIT $3
   ```

   Run with the same query embedding already computed for chunk search, in
   parallel with `searchProject()`. Results below a similarity cutoff
   (`FIGURE_MATCH_THRESHOLD`, default 0.5) are discarded — this is what
   prevents every answer from dragging in an unrelated image just because
   its page happened to match on text.

3. **Merge.** Combine (2)'s direct hits with (1)'s co-located figures for
   the chunks that were retrieved, dedupe by figure id, sort
   direct-matches-first then by score, cap at `MAX_FIGURES_PER_ANSWER`
   (default 4). This replaces the current dedupe-by-URL logic in
   `/embed/:publicId/retrieve` and `/embed/:publicId/study` with dedupe-by-id
   (still functionally equivalent, since URL is derived from id).

Both `/retrieve` and `/study` routes get this same merge logic — currently
they duplicate the page co-location lookup independently; this is a good
point to factor the merge into one shared helper (e.g. exported from
`vector.js` or a small new `figures.js` service) rather than copy-pasting it
into both routes a second time.

## API & frontend

No response shape changes. `figures[]` entries keep the same fields
(`pageImageUrl`, `caption`, `fileName`, `pdfUrl`, `pdfPage`) — `pageImageUrl`
now points at an individual crop's serving endpoint
(`/embed/:publicId/page-image/:pageImageId`, unchanged route, just now also
resolves cropped-figure rows) instead of always the whole page. Bounding box
data is stored server-side for cropping but not exposed in the API — nothing
in the current UI needs to highlight a region within a page, so surfacing it
would be speculative.

No frontend changes. `public/embed.html`'s figure-card rendering already
loops over `figures[]` and dedupes by URL — it was previously exercised with
at most one entry per answer in practice; this change makes multiple entries
an actual common case rather than a theoretical one already handled by the
existing loop.

## Error handling & limits

- `MAX_FIGURES_PER_PAGE` (default 6) caps vision-response parsing — any
  extra entries beyond the cap are ignored, logged at `warn`.
- Malformed/missing `box_2d` on an individual figure entry: skip that one
  figure (log + continue), don't fail the whole page.
- Crop dimensions that come out degenerate (zero or negative width/height
  after clamping to the page bounds) are skipped the same way.
- Caption-embedding batch failure: figures are still persisted without an
  embedding (as in step 3 above); they degrade to co-location-only
  reachability rather than being dropped.
- Everything here inherits the existing per-page try/catch in
  `processPdfPageImages` (one page's failure doesn't stop the rest) and the
  existing file-level try/catch in `process.js` (page-image processing
  failing doesn't fail the file itself).

## Testing plan

- Unit test the `box_2d` → pixel-rect conversion and clamping logic
  (including edge cases: out-of-range values, inverted min/max, zero-size
  boxes) — this is pure math, no I/O, cheapest to cover directly.
- Unit test the merge/dedupe logic in the new figures-retrieval helper with
  synthetic hit/figure fixtures (overlap between co-located and
  directly-matched sets, threshold cutoff behavior, cap enforcement).
- Manual verification: upload a PDF with a page containing 2+ distinct
  diagrams, confirm separate crops are produced with distinct captions, and
  confirm a targeted question about one diagram surfaces that crop
  specifically (not the other one, not a whole-page shot).
- Regression check: confirm a PDF processed under the old code path (single
  whole-page rows, no bbox/embedding) still renders correctly through
  `/retrieve` and `/study` — the backward-compatibility path is exercised by
  existing data, not just new uploads.

## Explicitly excluded (vs. the original spec)

- True embedded-raster image extraction (PyMuPDF-style) — the existing
  whole-page-raster approach is kept because many technical diagrams are
  vector-drawn directly in the PDF content stream, not embedded as raster
  images; per-image extraction alone would miss them. Cropping from the
  raster, not extracting XObjects, is how multiple figures get separated.
- OCR, WebP compression, image-hash-based dedup.
- Figure-reference text matching ("Fig. 3", "Diagram A") — retrieval relies
  on semantic caption matching instead.
- Flutter frontend, FastAPI backend, PyMuPDF/pdfplumber/Tesseract, and
  alternate vector databases (Pinecone/Qdrant/Weaviate/Chroma/Vertex AI
  Vector Search) — this stays on the existing Node/Express/pgvector/Gemini
  stack.
- Backfilling already-uploaded PDFs into the new multi-figure format.
