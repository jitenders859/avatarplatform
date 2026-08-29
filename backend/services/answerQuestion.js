/**
 * Core RAG Q&A logic shared between POST /embed/:publicId/ask
 * (backend/routes/embed.js) and the WhatsApp channel
 * (backend/routes/whatsapp.js — see
 * docs/competitor-feature-implementation-plan.md 3b). Extracted so the
 * WhatsApp handler doesn't duplicate retrieval/prompt/persistence logic —
 * it only has to map a WhatsApp message to a session and relay the reply.
 */
const crypto = require('crypto');
const uuid = crypto.randomUUID;
const db = require('../db');
const { embedOne } = require('./embed');
const { searchProject } = require('./vector');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const settings = require('./settings');
const logger = require('../logger').child({ module: 'answer-question' });

/** Fetch files for a set of chunk hits in one round trip instead of one query per hit. */
async function filesForHits(hits) {
  const ids = [...new Set(hits.map(h => h.chunk.fileId))];
  if (!ids.length) return new Map();
  const rows = await db.query('SELECT * FROM files WHERE id = ANY($1::uuid[])', [ids]);
  return new Map(rows.map(f => [f.id, f]));
}

/**
 * Answers one question against a project's knowledge base and persists the
 * turn. Returns { answer, sources, sessionId }. Callers are responsible for
 * their own quota checks (checkLimit) before calling this — this function
 * always persists and tracks usage.
 */
async function answerQuestion(project, question, incomingSessionId, { ip = 'unknown' } = {}) {
  const queryEmbedding = await embedOne(String(question).slice(0, 1500), 'RETRIEVAL_QUERY');
  const hits = await searchProject(project.id, queryEmbedding, 5);

  const fileCache = await filesForHits(hits);
  const sources = [];
  const contextParts = [];
  for (const hit of hits) {
    const file = fileCache.get(hit.chunk.fileId);
    contextParts.push(`[Source: ${file ? file.originalName : 'Unknown'}]\n${hit.chunk.text}`);
    if (file && !sources.find(s => s.fileId === file.id)) {
      sources.push({
        title: file.originalName || file.sourceUrl || 'Document',
        url: file.kind === 'url' ? file.sourceUrl : null,
        snippet: hit.chunk.text.slice(0, 180).trim(),
      });
    }
  }

  const systemPrompt = project.systemPrompt ||
    'You are a helpful AI assistant. Answer the user\'s question using the provided knowledge base context. Be concise and accurate.';
  const contextText = contextParts.length
    ? `Knowledge base context:\n\n${contextParts.join('\n\n---\n\n')}`
    : 'No relevant context found in the knowledge base.';
  const prompt = `${systemPrompt}\n\n${contextText}\n\nUser question: ${String(question).slice(0, 1000)}\n\nAnswer:`;

  const genai = new GoogleGenerativeAI(await settings.getSetting('GEMINI_API_KEY'));
  const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  const answer = result.response.text();

  let sid = incomingSessionId;
  try {
    if (!sid) {
      sid = uuid();
      await db.insert('sessions', { id: sid, projectId: project.id, ip, createdAt: Date.now() });
    }
    await db.insert('messages', {
      id: uuid(), sessionId: sid, projectId: project.id,
      role: 'user', text: String(question).slice(0, 2000), createdAt: Date.now(),
    });
    await db.insert('messages', {
      id: uuid(), sessionId: sid, projectId: project.id,
      role: 'assistant', text: answer.slice(0, 2000), createdAt: Date.now(),
      noAnswerFound: hits.length === 0,
    });
    const { trackMessage } = require('./usage');
    await trackMessage(project.userId).catch(() => {});
  } catch (e) {
    logger.error({ err: e.message }, 'answerQuestion persist failed');
  }

  return { answer, sources, sessionId: sid };
}

module.exports = { answerQuestion };
