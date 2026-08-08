/**
 * Semantic chunker — splits text into knowledge-base segments.
 *
 * Strategy (in priority order):
 *   1. Split on blank lines (paragraph boundaries).
 *   2. Within a paragraph group, split on sentence endings when needed.
 *   3. Never cut mid-word; always back up to the nearest space.
 *   4. Detect and attach headings from surrounding context.
 *   5. Apply configurable overlap (carry the last N chars of the previous chunk).
 *
 * Returns an array of chunk objects instead of plain strings:
 *   { text, idx, heading, pageHint, charCount, approxTokens }
 *
 * approxTokens uses the common 4-chars-per-token heuristic.
 *
 * Page numbers are NOT detected from the text itself — a prior version
 * tried to sniff form-feed characters, but pdf-parse never emits them (it
 * joins pages with a plain blank line), so that detection silently never
 * fired and every chunk got pageHint=1 regardless of its real page. Real
 * page numbers now come from chunkPages() below, which calls this function
 * once per page (via extractFile's structured `pages` output) and passes
 * the true page number in directly.
 */

const HEADING_RE   = /^(#{1,6})\s+(.+)$/m;           // Markdown headings
const PLAIN_HEAD_RE = /^([A-Z][A-Z\s]{3,60})$/m;     // ALL-CAPS plain text heading
const PLAIN_HEAD_MAX_LEN = 70;                       // whole paragraph must be short to count

/**
 * Extract a heading from a block of text — but only when the heading
 * effectively IS the whole paragraph, not merely present somewhere inside
 * it. A prior version used text.match(PLAIN_HEAD_RE) directly, which
 * matches if ANY line in a large paragraph happens to look like an
 * ALL-CAPS heading (common in dense forms/spec sheets with embedded
 * labels) — chunkText() then discarded the entire paragraph as
 * "heading-only", silently losing real body content. Gating on paragraph
 * length first fixes that: a genuine heading-only paragraph is short by
 * definition.
 */
function extractHeading(text) {
  const trimmed = text.trim();
  const md = trimmed.match(HEADING_RE);
  if (md) return md[2].trim();
  if (trimmed.length <= PLAIN_HEAD_MAX_LEN && PLAIN_HEAD_RE.test(trimmed)) return trimmed;
  return null;
}

/** Split text into sentence-boundary segments no larger than maxLen. */
function splitOnSentences(text, maxLen) {
  const parts = [];
  let remaining = text.trim();
  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    // Try sentence ends first, then clause commas, then spaces
    const sentIdx = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
      window.lastIndexOf('.\n'),
    );
    const commaIdx = window.lastIndexOf(', ');
    const spaceIdx = window.lastIndexOf(' ');
    let splitAt = sentIdx > maxLen * 0.4 ? sentIdx + 2
      : commaIdx > maxLen * 0.4 ? commaIdx + 2
      : spaceIdx > 0 ? spaceIdx + 1
      : maxLen;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.filter(Boolean);
}

/**
 * Main export.
 *
 * @param {string} raw - Full extracted text (one page's worth, for PDFs — see chunkPages)
 * @param {object} opts
 * @param {number} [opts.chunkSize=1200]   - Target chars per chunk
 * @param {number} [opts.overlap=150]      - Overlap chars carried into next chunk
 * @param {number} [opts.minChunkSize=100] - Discard chunks shorter than this
 * @param {number} [opts.pageHint=1]       - Page number to tag every chunk with
 * @returns {Array<{text, idx, heading, pageHint, charCount, approxTokens}>}
 */
function chunkText(raw, { chunkSize = 1200, overlap = 150, minChunkSize = 100, pageHint = 1 } = {}) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  // Split into paragraph blocks (double newline)
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  let currentChunk = '';
  let currentHeading = null;
  const segments = []; // { text, heading }

  function flush() {
    const t = currentChunk.trim();
    if (t.length >= minChunkSize) {
      segments.push({ text: t, heading: currentHeading });
    }
    currentChunk = '';
  }

  for (const para of paragraphs) {
    // Detect heading paragraph
    const heading = extractHeading(para);
    if (heading) {
      // Flush current chunk before starting a new section
      if (currentChunk.trim()) flush();
      currentHeading = heading;
      // A heading-only paragraph doesn't become its own chunk; it labels the next
      continue;
    }

    // Would this paragraph overflow the current chunk?
    const wouldBe = currentChunk ? currentChunk + '\n\n' + para : para;

    if (wouldBe.length <= chunkSize) {
      currentChunk = wouldBe;
    } else {
      // Flush what we have, then handle the paragraph
      if (currentChunk.trim()) flush();

      if (para.length <= chunkSize) {
        // Paragraph fits on its own
        currentChunk = para;
      } else {
        // Paragraph is too long — split on sentence boundaries
        const sentences = splitOnSentences(para, chunkSize);
        for (let i = 0; i < sentences.length; i++) {
          const sent = sentences[i];
          if (currentChunk) {
            const combined = currentChunk + ' ' + sent;
            if (combined.length <= chunkSize) {
              currentChunk = combined;
            } else {
              flush();
              currentChunk = sent;
            }
          } else {
            currentChunk = sent;
          }
        }
      }
    }
  }
  if (currentChunk.trim()) flush();

  // Apply overlap: prepend the last `overlap` chars of the previous chunk
  const chunks = [];
  for (let i = 0; i < segments.length; i++) {
    let chunkTextOut = segments[i].text;
    if (overlap > 0 && i > 0) {
      const prev = segments[i - 1].text;
      const carry = prev.slice(-overlap).trimStart();
      // Only carry if it won't push us massively over chunkSize
      if (carry && chunkTextOut.length + carry.length + 1 < chunkSize * 1.3) {
        chunkTextOut = carry + '\n' + chunkTextOut;
      }
    }
    const charCount = chunkTextOut.length;
    chunks.push({
      text:          chunkTextOut,
      idx:           i,
      heading:       segments[i].heading || null,
      pageHint,
      charCount,
      approxTokens:  Math.ceil(charCount / 4),
    });
  }

  return chunks;
}

/**
 * Chunk PDF content page-by-page, so each chunk gets an accurate real
 * page number (from extractFile's structured `pages` output) instead of
 * pageHint always being 1.
 *
 * @param {Array<{pageNumber: number, text: string}>} pages
 * @param {object} opts - same as chunkText's opts (minus pageHint)
 */
function chunkPages(pages, opts = {}) {
  const allChunks = [];
  let globalIdx = 0;
  for (const page of pages) {
    const pageChunks = chunkText(page.text, { ...opts, pageHint: page.pageNumber });
    for (const c of pageChunks) {
      allChunks.push({ ...c, idx: globalIdx++ });
    }
  }
  return allChunks;
}

module.exports = { chunkText, chunkPages };
