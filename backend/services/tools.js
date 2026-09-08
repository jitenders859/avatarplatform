/**
 * Tool registry for the /embed/:publicId/study function-calling loop.
 *
 * Each entry pairs a Gemini function declaration with its handler and a
 * minimum capability tier. backend/routes/embed.js filters this list down
 * to what a given project's tier unlocks, builds the Gemini `tools` param
 * from the declarations, and dispatches model tool calls to the handlers.
 *
 * Handlers receive (args, ctx) where ctx = { project }. They should return
 * a plain object — it's sent back to the model as the function's response.
 */
const crypto = require('crypto');
const db = require('../db');
const { meetsTier } = require('./tiers');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { embedOne } = require('./embed');
const { searchProject } = require('./vector');
const { safeFetch } = require('./safeFetch');
const settings = require('./settings');
const { computeCandidateSlots, subtractBusy } = require('./tourSlots');
const { getValidAccessToken, freeBusy, insertEvent, GoogleAuthRevokedError } = require('./googleCalendar');

// Quiz/flashcard synthesis is the accuracy-critical task (it's exam
// content), so it gets the fuller flash model, not flash-lite.
const QUIZ_MODEL = process.env.QUIZ_MODEL || 'gemini-3.5-flash';
const FLASHCARD_MODEL = process.env.FLASHCARD_MODEL || 'gemini-3.5-flash';

const QUIZ_QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    correctIndex: { type: 'integer' },
  },
  required: ['question', 'options', 'correctIndex'],
};

const FLASHCARD_SCHEMA = {
  type: 'object',
  properties: {
    front: { type: 'string' },
    back: { type: 'string' },
  },
  required: ['front', 'back'],
};

/**
 * Owner-authored questions first (zero hallucination risk by definition),
 * then AI-generated ones grounded strictly in retrieved knowledge-base
 * chunks — never the model's free/parametric knowledge. For an aviation
 * ground-school use case a hallucinated regulation in a quiz is a
 * liability problem, not just a bad answer, so an ungrounded topic returns
 * an explicit "not enough material" result instead of generating anyway.
 */
async function handleGenerateQuiz(args, ctx) {
  const topic = String(args?.topic || '').trim();
  if (!topic) return { error: 'topic is required' };
  const numQuestions = Math.min(Math.max(parseInt(args.numQuestions, 10) || 1, 1), 5);

  const questions = [];

  let bank = await db.findAll('quizQuestions', { projectId: ctx.project.id });
  const topicLower = topic.toLowerCase();
  bank = bank.filter(q => {
    const tag = q.topicTag && q.topicTag.toLowerCase();
    return (tag && (topicLower.includes(tag) || tag.includes(topicLower))) ||
      q.question.toLowerCase().includes(topicLower);
  });
  for (const q of bank.slice(0, numQuestions)) {
    questions.push({
      question: q.question, options: q.options, correctIndex: q.correctIndex,
      sourceChunkIds: [], origin: 'owner',
    });
  }

  const remaining = numQuestions - questions.length;
  if (remaining > 0) {
    const embedding = await embedOne(topic, 'RETRIEVAL_QUERY');
    const hits = await searchProject(ctx.project.id, embedding, 5);

    if (!hits.length) {
      if (!questions.length) {
        return { error: `No knowledge base content found for "${topic}". Try a different topic or upload more source material.` };
      }
      return { questions, note: `Only ${questions.length} question(s) available for "${topic}" — not enough knowledge base content to generate more.` };
    }

    const contextText = hits.map(h => h.chunk.text).join('\n\n---\n\n');
    const sourceChunkIds = hits.map(h => h.chunk.id);

    try {
      const genai = new GoogleGenerativeAI(await settings.getSetting('GEMINI_API_KEY'));
      const model = genai.getGenerativeModel({
        model: QUIZ_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: { type: 'array', items: QUIZ_QUESTION_SCHEMA },
        },
      });
      const prompt =
        `Using ONLY the following knowledge base context, write exactly ${remaining} distinct ` +
        `multiple-choice question(s) about "${topic}", each with exactly 4 options and one ` +
        "correct answer. Do not use any information beyond what's given below — if the context " +
        "doesn't fully support a question, write a narrower one that it does support. Don't " +
        `repeat the same concept across questions.\n\nContext:\n${contextText}`;

      const result = await model.generateContent(prompt);
      const generated = JSON.parse(result.response.text());
      for (const g of generated.slice(0, remaining)) {
        questions.push({ question: g.question, options: g.options, correctIndex: g.correctIndex, sourceChunkIds, origin: 'ai' });
      }
    } catch (e) {
      if (!questions.length) return { error: 'Quiz generation failed: ' + e.message };
      // Fall through and return what the owner bank already provided.
    }
  }

  return { questions };
}

/**
 * Same owner-bank-first, RAG-grounded-fill pattern as handleGenerateQuiz,
 * for front/back flashcards instead of multiple-choice questions.
 */
async function handleGenerateFlashcards(args, ctx) {
  const topic = String(args?.topic || '').trim();
  if (!topic) return { error: 'topic is required' };
  const numCards = Math.min(Math.max(parseInt(args.numCards, 10) || 1, 1), 5);

  const cards = [];

  let bank = await db.findAll('flashcards', { projectId: ctx.project.id });
  const topicLower = topic.toLowerCase();
  bank = bank.filter(c => {
    const tag = c.topicTag && c.topicTag.toLowerCase();
    return (tag && (topicLower.includes(tag) || tag.includes(topicLower))) ||
      c.front.toLowerCase().includes(topicLower);
  });
  for (const c of bank.slice(0, numCards)) {
    cards.push({ front: c.front, back: c.back, sourceChunkId: null, origin: 'owner' });
  }

  const remaining = numCards - cards.length;
  if (remaining > 0) {
    const embedding = await embedOne(topic, 'RETRIEVAL_QUERY');
    const hits = await searchProject(ctx.project.id, embedding, 5);

    if (!hits.length) {
      if (!cards.length) {
        return { error: `No knowledge base content found for "${topic}". Try a different topic or upload more source material.` };
      }
      return { cards, note: `Only ${cards.length} card(s) available for "${topic}" — not enough knowledge base content to generate more.` };
    }

    const contextText = hits.map(h => h.chunk.text).join('\n\n---\n\n');
    // One flashcard per generated card, so each can carry its own source
    // chunk (unlike the quiz batch, which shares one context pool).
    const primarySourceChunkId = hits[0].chunk.id;

    try {
      const genai = new GoogleGenerativeAI(await settings.getSetting('GEMINI_API_KEY'));
      const model = genai.getGenerativeModel({
        model: FLASHCARD_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: { type: 'array', items: FLASHCARD_SCHEMA },
        },
      });
      const prompt =
        `Using ONLY the following knowledge base context, write exactly ${remaining} distinct ` +
        `flashcards about "${topic}" as front/back pairs (front = a question or term, back = ` +
        "the answer or definition). Do not use any information beyond what's given below. " +
        `Don't repeat the same concept across cards.\n\nContext:\n${contextText}`;

      const result = await model.generateContent(prompt);
      const generated = JSON.parse(result.response.text());
      for (const g of generated.slice(0, remaining)) {
        cards.push({ front: g.front, back: g.back, sourceChunkId: primarySourceChunkId, origin: 'ai' });
      }
    } catch (e) {
      if (!cards.length) return { error: 'Flashcard generation failed: ' + e.message };
    }
  }

  return { cards };
}

/**
 * Matches against the owner-curated video library only — never a model-
 * generated link or live YouTube search. A model inventing a YouTube URL
 * is a broken link, and even a real search API can surface an unrelated
 * or low-quality video for a niche topic like FAA ground school. If the
 * curated list turns out too sparse to be useful in practice, a v2 worth
 * considering is a real YouTube Data API search as a fallback when no
 * curated match exists — not worth the added complexity/risk until there's
 * evidence of that gap.
 */
async function handleRecommendVideo(args, ctx) {
  const topic = String(args?.topic || '').trim();
  if (!topic) return { error: 'topic is required' };
  const topicLower = topic.toLowerCase();

  const videos = await db.findAll('videoResources', { projectId: ctx.project.id });
  const match = videos.find(v =>
    v.topicTags.some(tag => topicLower.includes(tag) || tag.includes(topicLower))
  );

  if (!match) {
    return { found: false, message: `No video available for "${topic}" yet.` };
  }
  return { found: true, title: match.title, youtubeUrl: match.youtubeUrl };
}

/**
 * Turns the model's own function-call arguments into a renderable "board"
 * — unlike quiz/flashcard generation, there's no separate grounding call
 * here: the model is just visually structuring what it's already
 * explaining (grounded by the same knowledge-base context already in the
 * turn's systemInstruction), so the handler's job is validating/capping
 * shape, not generating content.
 */
function handleExplainVisually(args) {
  const title = String(args?.title || 'Explanation').trim().slice(0, 100) || 'Explanation';
  const layout = args?.layout === 'map' ? 'map' : 'flow';

  const seenIds = new Set();
  const nodes = [];
  for (const raw of Array.isArray(args?.nodes) ? args.nodes : []) {
    if (nodes.length >= 8) break;
    const label = String(raw?.label || '').trim().slice(0, 60);
    if (!label) continue;
    let id = String(raw?.id || '').trim().slice(0, 40) || `n${nodes.length + 1}`;
    if (seenIds.has(id)) id = `${id}-${nodes.length + 1}`;
    seenIds.add(id);
    nodes.push({ id, label, detail: String(raw?.detail || '').trim().slice(0, 200) });
  }
  if (!nodes.length) return { error: 'At least one node with a label is required.' };

  const validIds = new Set(nodes.map(n => n.id));
  let edges = (Array.isArray(args?.edges) ? args.edges : [])
    .filter(e => validIds.has(e?.from) && validIds.has(e?.to) && e.from !== e.to)
    .slice(0, 12)
    .map(e => ({ from: e.from, to: e.to, label: String(e?.label || '').trim().slice(0, 30) || null }));

  // 'flow' with no edges given falls back to connecting the nodes in the
  // order the model listed them — the common case, since a step-by-step
  // sequence rarely needs explicit edges spelled out.
  if (!edges.length && layout === 'flow' && nodes.length > 1) {
    edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, label: null }));
  }

  return { board: { title, layout, nodes, edges } };
}

const TOOL_DEFS = [
  {
    minTier: 'medium',
    declaration: {
      name: 'get_project_topics',
      description:
        "Get the list of topics/headings covered in this project's knowledge base. " +
        "Call this when the user asks what topics you can help with, what's covered " +
        'in the material, or wants a study overview.',
      parameters: { type: 'object', properties: {} },
    },
    async handler(_args, ctx) {
      const rows = await db.query(
        `SELECT DISTINCT heading FROM chunks
         WHERE project_id = $1 AND heading IS NOT NULL
         LIMIT 20`,
        [ctx.project.id]
      );
      return { topics: rows.map(r => r.heading) };
    },
  },
  {
    minTier: 'advanced',
    declaration: {
      name: 'generate_quiz',
      description:
        'Generate multiple-choice quiz question(s) to test the user on a specific topic from ' +
        'the knowledge base. Always specify a concrete topic — ask the user what they want to ' +
        'be quizzed on if unclear, rather than calling this with a vague or missing topic.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The specific topic or concept to quiz the user on.' },
          numQuestions: { type: 'integer', description: 'How many questions to generate, 1-5. Default 1.' },
        },
        required: ['topic'],
      },
    },
    handler: handleGenerateQuiz,
  },
  {
    minTier: 'advanced',
    declaration: {
      name: 'generate_flashcards',
      description:
        'Generate front/back flashcards to help the user study a specific topic from the ' +
        'knowledge base. Always specify a concrete topic — ask the user what they want ' +
        'flashcards on if unclear, rather than calling this with a vague or missing topic.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The specific topic or concept to make flashcards for.' },
          numCards: { type: 'integer', description: 'How many flashcards to generate, 1-5. Default 1.' },
        },
        required: ['topic'],
      },
    },
    handler: handleGenerateFlashcards,
  },
  {
    minTier: 'medium',
    declaration: {
      name: 'recommend_video',
      description:
        "Recommend a curated video for a specific topic, if this project's owner has added one. " +
        'Always specify a concrete topic.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The topic to find a video for.' },
        },
        required: ['topic'],
      },
    },
    handler: handleRecommendVideo,
  },
  {
    minTier: 'medium',
    declaration: {
      name: 'explain_visually',
      description:
        "Create a visual explanation board — like a whiteboard diagram — for a concept that's " +
        "complex, multi-step, or that the user seems confused or stuck on (e.g. they said " +
        "\"I don't get it\", \"can you explain that differently\", \"I'm lost\", or asked for a " +
        'visual, diagram, or picture). Call this proactively whenever a visual breakdown would ' +
        "help more than more text — don't wait to be asked. Break the explanation into short, " +
        'connected pieces (2-8 of them) rather than one big paragraph: keep each label to a few ' +
        'words and each detail to one short sentence.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the board, e.g. "How Photosynthesis Works".' },
          layout: {
            type: 'string',
            enum: ['flow', 'map'],
            description:
              "'flow' for a step-by-step sequence, connected in the order listed — use for a " +
              "process, procedure, or cause-and-effect chain. 'map' for a central concept with " +
              'related ideas branching off it — use for a topic with several parts or a term ' +
              'with related sub-concepts. For "map", list the central concept as the FIRST node.',
          },
          nodes: {
            type: 'array',
            description: 'One box per idea/step, 2-8 of them.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Short unique id, e.g. "n1".' },
                label: { type: 'string', description: 'A few words — the name of this step/idea.' },
                detail: { type: 'string', description: 'One short sentence explaining it.' },
              },
              required: ['id', 'label'],
            },
          },
          edges: {
            type: 'array',
            description:
              'How nodes connect. For "flow" this can be omitted (nodes connect in the order ' +
              'listed). For "map", connect each branch node back to the central node.',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                label: { type: 'string', description: 'Optional short label on the connector.' },
              },
              required: ['from', 'to'],
            },
          },
        },
        required: ['title', 'layout', 'nodes'],
      },
    },
    handler: handleExplainVisually,
  },
];

/** Returns { declarations, dispatch } filtered to what `tier` unlocks. */
function toolsForTier(tier) {
  const defs = TOOL_DEFS.filter(t => meetsTier(tier, t.minTier));
  return {
    declarations: defs.map(t => t.declaration),
    dispatch: Object.fromEntries(defs.map(t => [t.declaration.name, t.handler])),
  };
}

/**
 * AI actions (see docs/competitor-feature-implementation-plan.md 1d) — an
 * owner-defined outbound webhook the model can call as a function during
 * /embed/:publicId/study's tool loop, e.g. "check_order_status". Signed
 * with the same HMAC scheme as services/webhookDelivery.js, but dispatched
 * synchronously (no retry/queue table) since the model is blocked waiting
 * on the result within the function-calling loop.
 */
async function callProjectAction(action, args, project) {
  const payload = {
    event: 'action', action: action.name, args: args || {}, projectId: project.id,
  };
  const payloadStr = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', project.webhookSecret || '').update(payloadStr).digest('hex');
  try {
    const response = await safeFetch(action.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Avatar-Signature': sig },
      body: payloadStr,
      timeout: 8000,
    });
    if (!response.ok) return { error: `Action endpoint returned HTTP ${response.status}` };
    return await response.json().catch(() => ({}));
  } catch (e) {
    return { error: 'Action failed: ' + e.message };
  }
}

/** Returns { declarations, dispatch } for a project's active custom actions. */
async function projectActionTools(project) {
  const rows = (await db.findAll('projectActions', { projectId: project.id })).filter(a => a.active);
  return {
    declarations: rows.map(a => ({
      name: a.name,
      description: a.description,
      parameters: (a.parameters && Object.keys(a.parameters).length) ? a.parameters : { type: 'object', properties: {} },
    })),
    dispatch: Object.fromEntries(rows.map(a => [a.name, (args, ctx) => callProjectAction(a, args, ctx.project)])),
  };
}

const CHECK_AVAILABILITY_DECLARATION = {
  name: 'check_availability',
  description:
    'Check when the project owner is free for a tour, so you can offer the visitor real open time slots. ' +
    'Call this whenever a visitor asks about scheduling, booking, or touring, before promising any specific ' +
    "time. Returns a short list of open slots near the date they asked about (or the soonest available if " +
    "they didn't give one).",
  parameters: {
    type: 'object',
    properties: {
      preferredDate: {
        type: 'string',
        description:
          'The date the visitor is interested in, as YYYY-MM-DD. If they said something relative like ' +
          '"tomorrow" or "next Tuesday", resolve it to an actual date yourself before calling. Omit if they ' +
          'gave no date preference — this returns the soonest few days of openings.',
      },
      rangeDays: {
        type: 'integer',
        description:
          'How many days forward from preferredDate to search for openings. Defaults to 3. Use a larger ' +
          'value (up to 14) if the visitor asked for a wider window or nothing was found nearby.',
      },
    },
  },
};

const BOOK_TOUR_DECLARATION = {
  name: 'book_tour',
  description:
    "Book a confirmed tour slot on the project owner's calendar. Only call this AFTER calling " +
    'check_availability and having the visitor confirm one of the returned slots, and after collecting their ' +
    'name and email (their email is where the calendar invite goes — ask for it explicitly if they haven\'t given it).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The visitor's full name." },
      email: { type: 'string', description: "The visitor's email address, to send the calendar invite to." },
      startTime: {
        type: 'string',
        description:
          'The exact ISO 8601 start time of the slot the visitor picked, copied verbatim from one of the ' +
          'startTime values check_availability returned — do not compute or guess this yourself.',
      },
    },
    required: ['name', 'email', 'startTime'],
  },
};

async function withAccessToken(connection, fn) {
  try {
    const accessToken = await getValidAccessToken(connection, (id, patch) => db.update('calendarConnections', id, patch));
    // fn (freeBusy/insertEvent) is inside this try too, not just the token
    // fetch above — Google can reject an access token that was valid at
    // refresh time but got revoked before this next call (see
    // googleCalendar.js's freeBusy/insertEvent 401 handling), and that needs
    // the same stale-connection cleanup as a revoked refresh token does.
    return await fn(accessToken);
  } catch (e) {
    if (e instanceof GoogleAuthRevokedError) {
      await db.remove('calendarConnections', { id: connection.id });
      return { error: 'Tour booking is not available right now.' };
    }
    return { error: 'Could not reach Google Calendar: ' + e.message };
  }
}

// Format-only regex accepts a calendar-invalid string like "2026-13-45".
// Date.UTC(y, m, d) with numeric args never throws — it silently rolls an
// out-of-range month/day forward into a real date instead — so comparing
// the round-tripped result back against the original string catches
// anything that isn't an actual calendar date, not just anything shaped
// like one. (The ISO-string Date constructor was tried first here and
// rejected: new Date("2026-13-45T00:00:00Z") produces an Invalid Date
// whose .toISOString() throws instead of returning a comparable value.)
function isValidDateStr(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === dateStr;
}

async function handleCheckAvailability(args, project, tourSettings, connection) {
  const rangeDays = Math.min(Math.max(parseInt(args?.rangeDays, 10) || 3, 1), 14);
  const fromDate = isValidDateStr(args?.preferredDate || '')
    ? args.preferredDate
    : new Date().toISOString().slice(0, 10);

  const candidates = computeCandidateSlots({ tourSettings, fromDate, rangeDays });
  if (!candidates.length) return { slots: [], note: 'No working hours are configured in that window.' };

  return withAccessToken(connection, async (accessToken) => {
    const busy = await freeBusy(
      accessToken,
      candidates[0].startUTC.toISOString(),
      candidates[candidates.length - 1].endUTC.toISOString()
    );
    const open = subtractBusy(candidates, busy).slice(0, 8);
    return { slots: open.map(s => ({ startTime: s.startUTC.toISOString(), label: s.label })) };
  });
}

async function handleBookTour(args, project, tourSettings, connection) {
  const name = String(args?.name || '').trim();
  const email = String(args?.email || '').trim();
  if (!name) return { error: 'name is required' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'A valid email is required' };

  const startUTC = new Date(String(args?.startTime || ''));
  if (isNaN(startUTC.getTime())) return { error: 'startTime must be a valid ISO 8601 timestamp' };
  const endUTC = new Date(startUTC.getTime() + tourSettings.durationMinutes * 60000);

  return withAccessToken(connection, async (accessToken) => {
    // Re-checking here narrows but doesn't eliminate the race: a second
    // visitor's book_tour could still slip in between this freeBusy call
    // and insertEvent below. Google Calendar has no conditional-create
    // primitive to close that fully; acceptable residual risk for two
    // visitors independently booking the exact same slot within
    // milliseconds of each other on a tour-booking chatbot.
    const busy = await freeBusy(accessToken, startUTC.toISOString(), endUTC.toISOString());
    if (busy.length) return { error: 'That slot was just booked by someone else — please check availability again.' };

    const calendarEventId = await insertEvent(accessToken, {
      summary: `Tour: ${project.name} — ${name}`,
      description: `Booked via the ${project.name} chatbot.\nVisitor email: ${email}`,
      location: tourSettings.location || undefined,
      startISO: startUTC.toISOString(),
      endISO: endUTC.toISOString(),
      attendeeEmail: email,
    });
    return { booked: true, startTime: startUTC.toISOString(), calendarEventId };
  });
}

/**
 * Returns { declarations, dispatch } for check_availability/book_tour —
 * empty unless the project is advanced tier, has tour_settings.enabled,
 * AND has a connected Google Calendar. Async and DB-backed like
 * projectActionTools above, unlike the static, tier-only toolsForTier.
 */
async function tourBookingTools(project) {
  if (!meetsTier(project.capabilityTier, 'advanced')) return { declarations: [], dispatch: {} };
  const tourSettings = project.tourSettings;
  if (!tourSettings || !tourSettings.enabled) return { declarations: [], dispatch: {} };
  const connection = await db.findOne('calendarConnections', { projectId: project.id });
  if (!connection) return { declarations: [], dispatch: {} };

  return {
    declarations: [CHECK_AVAILABILITY_DECLARATION, BOOK_TOUR_DECLARATION],
    dispatch: {
      check_availability: (args) => handleCheckAvailability(args, project, tourSettings, connection),
      book_tour: (args) => handleBookTour(args, project, tourSettings, connection),
    },
  };
}

module.exports = { toolsForTier, projectActionTools, tourBookingTools };
