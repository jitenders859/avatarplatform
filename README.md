# AvatarPlatform

A multi-tenant SaaS platform for embedding AI talking-character chatbots on any website. Built around a Rive runtime for real-time lip-sync, Gemini Live for speech-to-speech conversation, and Gemini embeddings + pgvector for RAG retrieval over uploaded files and URLs.

See [`project.md`](./project.md) for the full architecture, directory structure, API reference, and deployment guide. This README is a quick start.

## What's in this build

- **Auth** — signup, login, JWT, forgot/reset password flows
- **Projects** — multi-chatbot per user, each with its own character, voice, and persona
- **Knowledge sources** — upload PDFs, DOCX, TXT, MD, CSV, JSON, HTML, images, audio, video; or paste URLs to fetch + clean automatically
- **RAG retrieval** — Gemini embeddings, pgvector cosine search per project, source-card citations in chat
- **Gemini Live voice chat** — real-time speech-to-speech via WebSocket; viseme stream drives Rive lip-sync (ElevenLabs and OpenAI Realtime are also supported — see `/docs`)
- **Async Q&A** — `POST /embed/:publicId/ask` for text-only chat without a WebSocket (Gemini REST)
- **Floating widget** — bottom-right or bottom-left anchor, minimize/maximize, full-screen mode, RTL support, auto-language detection
- **Study tools** — owner-authored quizzes and flashcards, AI-generated ones, video recommendations, learner progress tracking (higher chatbot capability tiers)
- **Lead capture** — configurable capture fields per project; collected into a `leads` table with session linkage
- **Plans + billing** — 4 tiers (Free / Starter / Pro / Business), usage tracking, limit enforcement; Stripe checkout + Customer Portal + webhooks; coupon support
- **Admin panel** — user management, tier overrides, character library, coupons, audit log (`/admin`)
- **Analytics** — usage charts, per-bot breakdown
- **Drop-in embed** — one `<script>` tag with a `data-bot` attribute (`public/js/embed-loader.js`)
- **SDK packages** — `@avatar-platform/{js,react,vue,react-native}`, all thin wrappers over the same embed mechanism (see `packages/`)
- **Docs site** — full documentation at `/docs`
- **Marketing site** — homepage, pricing, characters, contact (with a contact form + optional cal.com booking), terms of service
- **i18n** — client-side UI translation (English, Spanish, French, Arabic, Hindi) with RTL layout support

## Quick start

```bash
git clone https://github.com/jitenders859/avatarplatform.git
cd avatarplatform
npm install
cp .env.example .env
# Required: DATABASE_URL, GEMINI_API_KEY, JWT_SECRET — see .env.example for the rest
```

Set up the database once: open your Postgres instance (a free Supabase project works well — it ships pgvector) and run the entire contents of `supabase/schema.sql`. It's idempotent, so re-running it later after a schema change is safe.

```bash
npm start           # production
npm run dev         # auto-restart on file changes (node --watch)
```

Open [http://localhost:8080](http://localhost:8080). You can run without `STRIPE_SECRET_KEY` (billing endpoints return 503, everything else works), without `UPSTASH_REDIS_REST_URL`/`REDIS_URL` (rate limiting falls back to in-memory, with a boot warning), and without `SMTP_HOST` (password-reset and contact-form emails no-op with a logged warning instead of failing).

## Environment variables

See [`.env.example`](./.env.example) for the full annotated list, or `project.md`'s [Environment Variables](./project.md#environment-variables) section for descriptions of each.

## Tests

```bash
npm test
```

Runs on Node's built-in test runner (`node --test`) — no test framework dependency, no database required (routes are tested against stubbed dependencies at the module boundary). CI (`.github/workflows/ci.yml`) additionally applies `supabase/schema.sql` to a real Postgres+pgvector service container on every push, to catch a schema error before it reaches a deployment.

## Adding character files

Characters are managed through the admin panel (`/admin` → Characters), which uploads a `.riv` file to Supabase Storage and inspects it in-browser using the real production Rive runtime. Every character must expose a **`Character`** artboard with an **`InLesson`** state machine and viseme number inputs **100–122** — see `public/lipsync-sdk.js`'s header comment for the full contract `public/js/admin/characters.js` checks against at upload time.

## Deployment

Deploys to Vercel out of the box (`api/index.js` wraps the Express app; `vercel.json` routes everything through it) or any Node host via `npm start`. See `project.md`'s [Deployment](./project.md#deployment) section for rate-limiting/Redis setup, background file-processing (Inngest vs. inline) configuration, and scaling notes.

## License

MIT
