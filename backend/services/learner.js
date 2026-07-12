/**
 * Resolves a durable "learner" identity across sessions for progress
 * tracking (quiz_attempts, flashcard_reviews).
 *
 * The sessions table is anonymous and effectively per-conversation, with
 * no durable identity of its own. Aviation ground-school students are
 * expected to return across multiple days/devices, so we tie learner
 * identity to whatever the project's email capture field resolves to for
 * that session's lead — not a localStorage id, which wouldn't survive a
 * device change. If a project hasn't configured an email capture field,
 * or no lead has captured one yet for this session, there's no durable
 * key available; progress is then only attributable to that one session.
 */
const db = require('../db');

async function resolveLearnerKey(projectId, sessionId) {
  const emailField = await db.findOne('captureFields', { projectId, type: 'email' });
  if (!emailField) return null;
  const lead = await db.findOne('leads', { sessionId, projectId });
  if (!lead || !lead.data || !lead.data[emailField.key]) return null;
  return String(lead.data[emailField.key]).toLowerCase().trim();
}

/**
 * Call after a lead is captured/updated. Backfills learner_key onto any
 * quiz_attempts/flashcard_reviews already logged for this session before
 * the email was captured (e.g. a visitor takes a quiz before the AI gets
 * around to asking for their email later in the same conversation).
 */
async function backfillLearnerKey(projectId, sessionId) {
  const learnerKey = await resolveLearnerKey(projectId, sessionId);
  if (!learnerKey) return;
  await db.query(
    'UPDATE quiz_attempts SET learner_key = $1 WHERE session_id = $2 AND learner_key IS NULL',
    [learnerKey, sessionId]
  );
  await db.query(
    'UPDATE flashcard_reviews SET learner_key = $1 WHERE session_id = $2 AND learner_key IS NULL',
    [learnerKey, sessionId]
  );
}

module.exports = { resolveLearnerKey, backfillLearnerKey };
