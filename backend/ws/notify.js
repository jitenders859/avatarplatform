/**
 * Schedules the "no one claimed this handoff request in time" email (see
 * services/email.js sendHandoffRequestEmail) with a grace window and a
 * per-project rate limit, so a repeatedly-re-requesting visitor can't
 * spam the team's inboxes. In-memory — fine given the confirmed
 * persistent-Node-process deployment target; a restart just means any
 * in-flight grace timers are lost, which only means one possible missed
 * email, not a correctness bug.
 */
const db = require('../db');
const { sendHandoffRequestEmail } = require('../services/email');
const logger = require('../logger').child({ module: 'ws/notify' });

const GRACE_MS = 20_000;
const RATE_LIMIT_MS = 5 * 60_000;

const timers = new Map();            // sessionId -> Timeout
const lastSentByProject = new Map(); // projectId -> timestamp

function scheduleHandoffEmail(sessionId, project) {
  cancelHandoffEmail(sessionId);
  const timer = setTimeout(() => fire(sessionId, project), GRACE_MS);
  timers.set(sessionId, timer);
}

async function fire(sessionId, project) {
  timers.delete(sessionId);
  const last = lastSentByProject.get(project.id) || 0;
  if (Date.now() - last < RATE_LIMIT_MS) return;
  try {
    const session = await db.findOne('sessions', { id: sessionId });
    if (!session || session.handoffStatus !== 'requested') return; // claimed (or gone) already
    const owner = await db.findOne('users', { id: project.userId });
    const members = await db.query(
      `SELECT u.email FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1`,
      [project.id]
    );
    const recipients = [owner?.email, ...members.map(m => m.email)].filter(Boolean);
    const firstMessage = await db.queryOne(
      `SELECT text FROM messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [sessionId]
    );
    await sendHandoffRequestEmail({ project, previewText: firstMessage?.text || '', recipients });
    lastSentByProject.set(project.id, Date.now());
  } catch (e) {
    logger.error({ err: e.message, sessionId }, 'handoff request email failed');
  }
}

function cancelHandoffEmail(sessionId) {
  const timer = timers.get(sessionId);
  if (timer) { clearTimeout(timer); timers.delete(sessionId); }
}

// Test-only.
function _reset() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  lastSentByProject.clear();
}

module.exports = { scheduleHandoffEmail, cancelHandoffEmail, _reset, GRACE_MS, RATE_LIMIT_MS };
