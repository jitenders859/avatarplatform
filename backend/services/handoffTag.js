/**
 * Shared AI auto-escalation sentinel, mirroring the existing
 * [[CAPTURE:key=value]] / [[OPTIONS:...]] pattern used for lead capture
 * and quick replies (see public/embed.html) — a system-prompt instruction
 * plus a regex strip, not a Gemini function-calling tool, so it works at
 * every capability tier (not just the ones with tool-calling enabled).
 * Used server-side by /ask and /study (backend/routes/embed.js); the
 * voice/SDK path strips the identical tag client-side in embed.html using
 * the same instruction text baked into that page's system prompt builder.
 */
const HANDOFF_INSTRUCTION = `

HUMAN HANDOFF: If you cannot help the visitor after a genuine effort, or
they explicitly ask for a person/human/representative, say so naturally
and append the exact tag [[REQUEST_HUMAN]] on its own line. Do not mention
the tag to the user — it will be stripped before display.`;

const HANDOFF_TAG_RE = /\[\[REQUEST_HUMAN\]\]/g;

function extractHandoffTag(text) {
  const str = String(text || '');
  let requested = false;
  let clean = str.replace(HANDOFF_TAG_RE, () => { requested = true; return ''; });
  if (requested) {
    // Collapse the double space left behind when the tag sat mid-line between
    // two words (e.g. "connect you. [[REQUEST_HUMAN]] One moment." ->
    // "connect you.  One moment." after the tag is removed), and collapse any
    // blank-line runs left behind when it sat on its own line. Only do this
    // when a tag was actually found — otherwise ordinary formatting (indented
    // code, nested markdown lists, ASCII art, a stylistic double space) would
    // get silently mangled on every response even though nothing was stripped.
    clean = clean.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  return { clean, requested };
}

module.exports = { HANDOFF_INSTRUCTION, extractHandoffTag };
