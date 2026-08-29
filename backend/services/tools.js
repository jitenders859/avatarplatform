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
const db = require('../db');
const { meetsTier } = require('./tiers');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { embedOne } = require('./embed');
const { searchProject } = require('./vector');
const settings = require('./settings');

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
];

/** Returns { declarations, dispatch } filtered to what `tier` unlocks. */
function toolsForTier(tier) {
  const defs = TOOL_DEFS.filter(t => meetsTier(tier, t.minTier));
  return {
    declarations: defs.map(t => t.declaration),
    dispatch: Object.fromEntries(defs.map(t => [t.declaration.name, t.handler])),
  };
}

module.exports = { toolsForTier };
