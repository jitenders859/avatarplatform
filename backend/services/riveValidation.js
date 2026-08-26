/**
 * Lightweight server-side sanity check for uploaded .riv files.
 *
 * This is NOT full contract validation (artboard "Character", state
 * machine "InLesson", inputs 100-122) — there's no Rive parser available
 * in Node, and per-decision the real contract check happens client-side
 * in the admin panel via the same rive.js runtime production uses (a
 * genuine in-browser inspector, which doubles as the "test before
 * releasing" step). This only confirms the uploaded bytes are actually a
 * Rive binary at all, confirmed against the real magic bytes of the
 * existing public/assets/characters/*.riv files (52 49 56 45 = "RIVE").
 */
const RIVE_MAGIC = Buffer.from('RIVE', 'ascii');

function isValidRiveBinary(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= RIVE_MAGIC.length && buffer.subarray(0, 4).equals(RIVE_MAGIC);
}

module.exports = { isValidRiveBinary };
