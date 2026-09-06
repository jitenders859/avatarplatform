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
const { searchWebForProject } = require('./searchWeb');
const logger = require('../logger').child({ module: 'answer-question' });

// Web search fallback trigger (see docs/superpowers/specs/2026-09-05-web-search-grounding-design.md
// Part 2) — /ask has no tool-calling loop, so there's no model decision
// point the way the Live path has; this heuristic gate stands in for it.
const TIME_SENSITIVE_RE = /\b(latest|current(ly)?|today|this week|this year|right now|price|cost|version|release|schedule|news)\b/i;

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
async function answerQuestion(project, question, incomingSessionId, { ip = 'unknown', pageContext = null } = {}) {
  const queryEmbedding = await embedOne(String(question).slice(0, 1500), 'RETRIEVAL_QUERY');
  const hits = await searchProject(project.id, queryEmbedding, 5);

  const fileCache = await filesForHits(hits);
  const sources = [];
  const contextParts = [];

  // pageContext is volunteered by the widget (extracted client-side from the
  // host page — see public/js/embed-loader.js) and only trusted when the
  // owner has opted in; project.pageContextEnabled is the server-side gate,
  // not the client's request alone (see middleware/validate.js's ask schema).
  if (project.pageContextEnabled && pageContext && (pageContext.text || pageContext.title)) {
    const label = [pageContext.title, pageContext.url].filter(Boolean).join(' — ');
    contextParts.push(
      `[Content of the page the visitor is currently viewing${label ? `: ${label}` : ''}]\n${String(pageContext.text || '').slice(0, 6000)}`
    );
  }

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

  // hits.length === 0 already means "below RAG_MIN_SCORE" (vector.js
  // filters those rows out server-side), so that alone is the confidence
  // signal; the regex additionally catches a time-sensitive question the KB
  // might technically have stale content for.
  let usedWebFallback = false;
  if (project.webSearchEnabled && (hits.length === 0 || TIME_SENSITIVE_RE.test(question))) {
    try {
      const webResults = await searchWebForProject(project, question, { language: 'en' });
      for (const r of webResults) {
        contextParts.push(`[Web result: ${r.title}]\n${r.snippet}`);
        sources.push({ title: r.title, url: r.url, snippet: r.snippet });
      }
      usedWebFallback = webResults.length > 0;
    } catch (e) {
      logger.warn({ err: e.message }, 'ask web-search fallback failed — continuing with KB-only context');
    }
  }

  // Owner's static fallback message (project.fallbackMessage) skips the
  // model call entirely rather than letting it guess, but only when there's
  // truly no grounding context at all — a successful web-search fallback
  // above still gets a real, generated answer.
  let answer;
  if (hits.length === 0 && !usedWebFallback && project.fallbackMessage) {
    answer = project.fallbackMessage;
  } else {
    const systemPrompt = project.systemPrompt ||
      'You are a helpful AI assistant. Answer the user\'s question using the provided knowledge base context. Be concise and accurate.';
    const contextText = contextParts.length
      ? `Knowledge base context:\n\n${contextParts.join('\n\n---\n\n')}`
      : 'No relevant context found in the knowledge base.';
    const prompt = `${systemPrompt}\n\n${contextText}\n\nUser question: ${String(question).slice(0, 1000)}\n\nAnswer:`;

    const genai = new GoogleGenerativeAI(await settings.getSetting('GEMINI_API_KEY'));
    const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(prompt);
    answer = result.response.text();
  }

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
