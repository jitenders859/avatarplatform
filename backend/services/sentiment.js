/**
 * Sentiment tagging (see docs/competitor-feature-implementation-plan.md 1c)
 * — a periodic Inngest job (backend/inngest/functions.js#sentimentTagJob)
 * tags recently-finished sessions with one Gemini call over the transcript,
 * rather than a synchronous per-message call that would add latency to
 * every live turn for no user-facing benefit.
 */
const db = require('../db');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const settings = require('./settings');
const logger = require('../logger').child({ module: 'sentiment' });

const BATCH_SIZE = 20;
// Only tag sessions that have gone quiet — skips a conversation still in
// progress, which wouldn't have a settled sentiment yet.
const QUIET_MS = 5 * 60 * 1000;
const VALID = new Set(['positive', 'neutral', 'negative']);

async function classifySentiment(transcript) {
  const genai = new GoogleGenerativeAI(await settings.getSetting('GEMINI_API_KEY'));
  const model = genai.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties: { sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] } }, required: ['sentiment'] },
    },
  });
  const prompt = `Classify the overall sentiment of this chatbot conversation transcript as exactly one of positive, neutral, or negative — based on how satisfied the visitor seems, not the topic.\n\n${transcript}`;
  const result = await model.generateContent(prompt);
  const parsed = JSON.parse(result.response.text());
  return VALID.has(parsed.sentiment) ? parsed.sentiment : 'neutral';
}

/** Tags up to BATCH_SIZE quiet, untagged sessions. Returns how many were tagged. */
async function tagRecentSessions() {
  const cutoff = Date.now() - QUIET_MS;
  const rows = await db.query(
    `SELECT s.id FROM sessions s
      WHERE s.sentiment IS NULL AND s.created_at < $1
        AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [cutoff, BATCH_SIZE]
  );

  let tagged = 0;
  for (const row of rows) {
    try {
      const messages = await db.findAll('messages', { sessionId: row.id }, { orderBy: 'createdAt', order: 'asc' });
      const transcript = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(0, 40)
        .map(m => `${m.role}: ${(m.text || '').slice(0, 500)}`)
        .join('\n')
        .slice(0, 6000);
      if (!transcript) {
        await db.update('sessions', row.id, { sentiment: 'neutral', updatedAt: Date.now() });
        continue;
      }
      const sentiment = await classifySentiment(transcript);
      await db.update('sessions', row.id, { sentiment, updatedAt: Date.now() });
      tagged++;
    } catch (e) {
      logger.warn({ err: e.message, sessionId: row.id }, 'sentiment tagging failed for session');
    }
  }
  return tagged;
}

module.exports = { tagRecentSessions };
