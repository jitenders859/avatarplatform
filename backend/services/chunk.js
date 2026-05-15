/**
 * Sliding-window chunker. Aims for ~chunkSize characters per chunk
 * with `overlap` chars of carry-over to keep semantic continuity at
 * boundaries. Splits on paragraph/sentence boundaries when possible.
 */
function chunkText(raw, { chunkSize = 1200, overlap = 200 } = {}) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  if (text.length <= chunkSize) return [text];

  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + chunkSize, text.length);

    // If we're not at the end, try to back up to a sentence/paragraph break
    if (end < text.length) {
      const window = text.slice(i, end);
      // Prefer paragraph break, then sentence end, then space
      const paraIdx = window.lastIndexOf('\n\n');
      const sentIdx = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('? '),
        window.lastIndexOf('! '),
      );
      const spaceIdx = window.lastIndexOf(' ');
      const breakAt =
        paraIdx > chunkSize * 0.5 ? paraIdx + 2 :
        sentIdx > chunkSize * 0.5 ? sentIdx + 2 :
        spaceIdx > chunkSize * 0.5 ? spaceIdx + 1 :
        window.length;
      end = i + breakAt;
    }

    const chunk = text.slice(i, end).trim();
    if (chunk) chunks.push(chunk);

    if (end >= text.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks;
}

module.exports = { chunkText };
