/**
 * Semantic chunker — splits text into knowledge-base segments.
 *
 * Strategy (in priority order):
 *   1. Split on blank lines (paragraph boundaries).
 *   2. Within a paragraph group, split on sentence endings when needed.
 *   3. Never cut mid-word; always back up to the nearest space.
 *   4. Detect and attach headings from surrounding context.
 *   5. Detect PDF page markers and carry the page number forward.
 *   6. Apply configurable overlap (carry the last N chars of the previous chunk).
 *
 * Returns an array of chunk objects instead of plain strings:
 *   { text, idx, heading, pageHint, charCount, approxTokens }
 *
 * approxTokens uses the common 4-chars-per-token heuristic.
 */

const HEADING_RE   = /^(#{1,6})\s+(.+)$/m;           // Markdown headings
const PLAIN_HEAD_RE = /^([A-Z][A-Z\s]{3,60})$/m;     // ALL-CAPS plain text heading
const PAGE_MARKER_RE = /(?:^|\n)[-–—]{3,}\s*[Pp]age\s+(\d+)\s*[-–—]{3,}/;
const FORM_FEED_RE   = /\f/g;

/** Replace form-feed page breaks with explicit markers so we can track pages. */
function normalizePageBreaks(text) {
  let page = 1;
  return text.replace(FORM_FEED_RE, () => `\n\n--- Page ${++page} ---\n\n`);
}

/** Extract current heading from a block of text (first heading line wins). */
function extractHeading(text) {
  const md = text.match(HEADING_RE);
  if (md) return md[2].trim();
  const plain = text.match(PLAIN_HEAD_RE);
  if (plain) return plain[1].trim();
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
 * @param {string} raw - Full extracted text
 * @param {object} opts
 * @param {number} [opts.chunkSize=1200]   - Target chars per chunk
 * @param {number} [opts.overlap=150]      - Overlap chars carried into next chunk
 * @param {number} [opts.minChunkSize=100] - Discard chunks shorter than this
 * @returns {Array<{text, idx, heading, pageHint, charCount, approxTokens}>}
 */
function chunkText(raw, { chunkSize = 1200, overlap = 150, minChunkSize = 100 } = {}) {
  const text = normalizePageBreaks(String(raw || '').replace(/\r\n/g, '\n').trim());
  if (!text) return [];

  // Split into paragraph blocks (double newline)
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  let currentChunk = '';
  let currentHeading = null;
  let currentPage = 1;
  const segments = []; // { text, heading, pageHint }

  function flush() {
    const t = currentChunk.trim();
    if (t.length >= minChunkSize) {
      segments.push({ text: t, heading: currentHeading, pageHint: currentPage });
    }
    currentChunk = '';
  }

  for (const para of paragraphs) {
    // Detect page marker paragraph
    const pageMatch = para.match(/---\s*[Pp]age\s+(\d+)\s*---/);
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
      continue;
    }

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
    let chunkText = segments[i].text;
    if (overlap > 0 && i > 0) {
      const prev = segments[i - 1].text;
      const carry = prev.slice(-overlap).trimStart();
      // Only carry if it won't push us massively over chunkSize
      if (carry && chunkText.length + carry.length + 1 < chunkSize * 1.3) {
        chunkText = carry + '\n' + chunkText;
      }
    }
    const charCount = chunkText.length;
    chunks.push({
      text:          chunkText,
      idx:           i,
      heading:       segments[i].heading || null,
      pageHint:      segments[i].pageHint,
      charCount,
      approxTokens:  Math.ceil(charCount / 4),
    });
  }

  return chunks;
}

module.exports = { chunkText };
