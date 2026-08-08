# Advanced Chatbot Features — Build Prompts

Each block below is self-contained — copy one into a session and work through it before
moving to the next. They're ordered by dependency (later ones assume earlier ones exist).

## Tier model

New axis, separate from the existing billing plans (Free/Starter/Pro/Business in `backend/plans.js`,
which gate usage volume). This is a **capability** tier per chatbot project:

- **Basic** — what exists today: RAG chat (voice + text), lead capture, source citation cards.
- **Medium** — adds richer, still-passive content delivery: referenced images/diagrams from source
  docs, direct PDF page links, curated video recommendations, slide viewer.
- **Advanced** — adds interactive/stateful study tools: quiz generation with grading, flashcards,
  per-learner progress tracking.

A project owner picks a tier per chatbot; higher tiers are a superset of lower ones.

---

## Prompt 0 — Capability tier foundation

Add a capability-tier system to the avatar platform, independent of the existing billing plans in
`backend/plans.js`. Add a `capabilityTier` column to `projects` (`'basic' | 'medium' | 'advanced'`,
default `'basic'`) via a migration on the live Supabase DB + update to `supabase/schema.sql`. Expose
it as a selector in the project settings UI (`public/project.html`), saved via the existing
PATCH `/api/projects/:id` route. Add `backend/services/tiers.js` exporting a `featuresFor(tier)`
helper returning a flags object, e.g.:

```js
{ referencedImages: false, videoRecommendations: false, slides: false,
  quizzes: false, flashcards: false, progressTracking: false }
```

with flags escalating true across basic → medium → advanced per the tier model above. Don't build
any actual feature yet — just the field, the settings toggle, and the flag-lookup helper that every
later prompt's routes/tools will check before executing (return a clear "not available on your
plan" response otherwise, don't silently no-op).

---

## Prompt 1 — Tool-calling infrastructure

Add Gemini function/tool-calling to the text chat path in `backend/routes/embed.js` (the `/ask`
route, or a new `/study` route if you want to keep quiz/flashcard traffic separate from plain
Q&A — decide based on how the frontend will call this). Build a minimal, reusable scaffold:

- A `tools` array of Gemini function declarations, passed into the `generateContent` call.
- A dispatch table mapping tool name → handler function.
- A loop that re-invokes the model with tool results until it returns a final text answer
  (standard function-calling loop — the model may call a tool, get a result, then call another
  tool or answer directly).

Prove the plumbing with one throwaway tool (e.g. `get_project_topics`) before any real tool exists.
Gate the whole path behind `capabilityTier !== 'basic'` using `tiers.js` from Prompt 0. This is
pure infrastructure — no quiz/flashcard logic here, just the wiring the next four prompts hang off.

Note: this only applies to the text/REST chat path. The Gemini Live voice path
(`public/lipsync-sdk.js`) doesn't currently do tool-calling at all — leave voice as pure
conversational RAG for now; don't try to wire tools into the Live session in this pass.

---

## Prompt 2 — Quiz generation (RAG-grounded)

Add a `generate_quiz` tool (using the Prompt 1 scaffold) that synthesizes multiple-choice questions
**only** from retrieved knowledge-base chunks (reuse `backend/services/vector.js`'s `searchProject`)
— this must not invent facts outside the retrieved context; for an aviation ground-school test-prep
use case, a hallucinated regulation or airspace minimum in a quiz is a real liability problem, not
just a bad answer. Each generated question should carry the source chunk id(s) it was derived from.

Response shape: `{ question, options: string[], correctIndex, sourceChunkIds }`. Add a quiz-taking
UI in `public/embed.html` — a card with the question, clickable options, immediate right/wrong
feedback, and a "why" link back to the source chunk/citation (reuse the existing `source-card`
pattern). Persist each attempt to a new `quiz_attempts` table (`id, project_id, session_id,
question, selected_index, correct_index, is_correct, source_chunk_ids, created_at`) — this feeds
Prompt 4's progress tracking. Gate behind `capabilityTier === 'advanced'`.

---

## Prompt 3 — Flashcards (RAG-grounded)

Same grounding constraint as Prompt 2: `generate_flashcards` tool synthesizes `{front, back,
sourceChunkId}` cards only from retrieved chunks, never free-generated trivia. Add a flip-card UI
in `embed.html` (tap/click to flip, swipe or button for next). Self-report review ("got it" /
"still learning") rather than full spaced-repetition scheduling for v1 — keep it simple. Persist
to a new `flashcard_reviews` table (`id, project_id, session_id, front, back, source_chunk_id,
self_rating, created_at`). Gate behind `capabilityTier === 'advanced'`.

---

## Prompt 4 — Progress tracking

Aggregate `quiz_attempts` + `flashcard_reviews` into a per-topic mastery view. First decide how a
"learner" persists across visits — today's `sessions` table is anonymous and effectively
per-browser-tab/per-conversation, with no durable identity. Options: tie to the existing lead-capture
email (if the project collects one), or a `localStorage`-persisted pseudo-learner id scoped to the
embed widget. Pick based on whether this client's students are expected to return across multiple
days/devices (likely yes, for exam prep — lean toward requiring an email/name via capture fields
as the learner key). Build:

- An in-widget "Your progress" panel (accuracy by topic, cards reviewed, streak).
- An extension to the project owner's analytics (`public/project.html`'s existing tabs) showing
  aggregate learner progress across all students.

Gate behind `capabilityTier === 'advanced'`.

---

## Prompt 5 — Referenced images, diagrams, and PDF page links

This is the multimodal-RAG design already scoped in an earlier session (page rasterization +
Gemini vision classify/caption for diagram-bearing pages, inline auto-embedded figures in the chat
bubble, direct PDF links opened at `#page=N`, recommended model `gemini-2.5-flash` for page
captioning). Pick that design back up rather than re-deriving it — implement per what was
discussed: fix the currently-broken page-number tracking in `backend/services/chunk.js` first
(pdf-parse doesn't emit form feeds, so `pageHint` is always `1` today), then add the page-image
pipeline, then wire display into `embed.html`. Gate behind `capabilityTier !== 'basic'` (available
at medium and advanced).

---

## Prompt 6 — Curated video recommendations

Add a `recommend_video` tool. Start with a curated library, not live YouTube API search or
model-generated links — a chatbot inventing a YouTube URL is a broken link, and even a real
search API can surface an unrelated or low-quality video for a niche topic like FAA ground school.
Add a `video_resources` table (`id, project_id, topic_tags text[], title, youtube_url, created_at`)
and a simple curation UI in `project.html` where the project owner adds `{topic, url}` pairs. The
tool matches the retrieved chunk's heading/topic against `topic_tags` and returns a match if one
exists, otherwise says it doesn't have a video for that topic rather than guessing. Note a v2 option
in a comment: real YouTube Data API search, only worth it once there's evidence the curated list is
too sparse to be useful. Gate behind `capabilityTier !== 'basic'`.

---

## Prompt 7 — Slide viewer

Depends on Prompt 5's page-image pipeline. Add a `show_slide`/`show_slides` tool that pages through
a source document's rendered page images as a lightweight carousel/lightbox (distinct from Prompt
5's inline single-figure display — this is for "walk me through the slide deck" style requests,
multiple pages in sequence). Reuse the `page_images` table and serving route from Prompt 5 rather
than building a second image pipeline. Gate behind `capabilityTier !== 'basic'`.
