/**
 * Picks how a queued file upload actually gets processed (extract → chunk
 * → embed). Two modes:
 *
 *   'inline'  — runs in-process via setImmediate, right after the request
 *               that queued it. Works with zero external setup, but only
 *               reliably finishes on a long-lived process (`npm start` /
 *               `npm run dev`) — a Vercel serverless function is frozen
 *               shortly after its response is sent, so inline processing
 *               there can be cut off mid-pipeline.
 *   'inngest' — durable background jobs via Inngest (backend/inngest/),
 *               unaffected by the Vercel freeze, but requires an Inngest
 *               account/keys configured (see project.md's Inngest section).
 *
 * PROCESS_MODE env var picks explicitly; unset defaults to 'inline'
 * everywhere except Vercel (VERCEL=1 is set on every Vercel invocation),
 * where inline processing is known-broken so it defaults to 'inngest'
 * instead. That default only actually works once Inngest is configured —
 * see checkProcessModeConfigured()'s boot-time warning for the case where
 * it isn't.
 */
function resolveProcessMode() {
  const mode = process.env.PROCESS_MODE;
  if (mode === 'inngest' || mode === 'inline') return mode;
  return process.env.VERCEL ? 'inngest' : 'inline';
}

/** Call once at boot. Logs a loud warning for the one combination that silently breaks uploads: Vercel + Inngest unconfigured. */
function checkProcessModeConfigured(logger) {
  if (resolveProcessMode() !== 'inngest') return;
  if (process.env.INNGEST_EVENT_KEY || process.env.INNGEST_SIGNING_KEY) return;
  logger.warn(
    'PROCESS_MODE is "inngest" (' +
      (process.env.PROCESS_MODE ? 'explicitly set' : 'defaulted on Vercel') +
      ') but INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY are not set — queued file uploads will send events nothing ' +
      'is listening for and stay stuck in "processing" forever. Configure Inngest (see project.md), or set ' +
      'PROCESS_MODE=inline to accept the Vercel-freeze risk instead.'
  );
}

module.exports = { resolveProcessMode, checkProcessModeConfigured };
