# AvatarPlatform — Project Reference

Multi-tenant SaaS that lets users build embeddable AI talking-character chatbots and drop them onto any website with a single script tag. Built on Rive (animated characters), Gemini Live (voice conversation), and Gemini Embeddings (RAG knowledge retrieval), with Supabase/Postgres as the database.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Directory Structure](#directory-structure)
3. [Quick Start](#quick-start)
4. [Environment Variables](#environment-variables)
5. [Database Setup (Supabase)](#database-setup-supabase)
6. [API Reference](#api-reference)
7. [Embed Widget](#embed-widget)
8. [Plans & Billing](#plans--billing)
9. [Character Files](#character-files)
10. [Deployment](#deployment)

---

## Architecture Overview

```
Browser (embed.html)                   Browser (dashboard)
   │  Gemini Live WebSocket               │  REST API calls
   │  (client-side, direct)               │
   └──────────────────────────────────────┤
                                          │
              ┌───────────────────────────▼──────────────────────────┐
              │                  Express server                       │
              │  /api/auth        JWT signup / login / reset          │
              │  /api/projects    CRUD + sessions + leads             │
              │  /api/projects/:id/files   upload + URL ingest        │
              │  /api/billing     Stripe checkout / portal / webhook  │
              │  /api/analytics   SQL-aggregate charts                │
              │  /embed/:id/*     public config + RAG retrieve + log  │
              └──────────┬───────────────────────────────────────────┘
                         │
            ┌────────────┼────────────────────────┐
            │            │                        │
     ┌──────▼──────┐  ┌──▼──────────┐  ┌─────────▼──────────┐
     │  Supabase   │  │  Gemini API │  │  Stripe API        │
     │  Postgres   │  │  Embeddings │  │  Checkout / Portal │
     │  pgvector   │  │  (server)   │  │  Webhook events    │
     └─────────────┘  └─────────────┘  └────────────────────┘
```

**Data flow for a chat message:**
1. Visitor speaks or types into `embed.html` — one persistent Gemini Live session handles both, so the AI keeps the conversation's context rather than restarting fresh per message
2. Whenever the model decides it needs specific knowledge-base content, it calls the `search_knowledge_base` function-calling tool declared in the Live session setup (`public/lipsync-sdk.js`'s `opts.tools`)
3. The tool's handler (`embed.html`) calls `POST /embed/:id/retrieve`; the server embeds the query with Gemini, runs pgvector cosine search (dropping anything below `RAG_MIN_SCORE`), and returns top-K chunks
4. Results are sent back over the same Live connection as the function's response — the AI answers grounded in that content, and the widget attaches the matching source citations to the reply
4. Transcript logged via `POST /embed/:id/log` for analytics and webhooks

---

## Directory Structure

```
avatar-platform/
├── api/
│   └── index.js                   # Vercel serverless entry point (wraps backend/server.js)
├── backend/
│   ├── server.js                  # Express entry point
│   ├── db.js                      # Postgres layer (pg.Pool, camelCase↔snake_case)
│   ├── plans.js                   # Plan definitions + limits
│   ├── errors.js                  # AppError class (safe, user-facing error messages)
│   ├── logger.js                  # pino logger
│   ├── middleware/
│   │   ├── auth.js                # JWT authRequired/adminAuthRequired + signToken
│   │   └── validate.js            # Zod request-body validation
│   ├── inngest/
│   │   ├── client.js              # Inngest client
│   │   └── functions.js           # Background jobs (file processing)
│   ├── scripts/
│   │   ├── create-admin.js        # One-off: create an admin_users row
│   │   └── migrate-legacy-characters.js
│   ├── routes/
│   │   ├── auth.js                # Signup, login, reset password, /me
│   │   ├── projects.js            # Project CRUD, sessions, leads
│   │   ├── files.js               # File upload, URL ingest, chunks viewer
│   │   ├── embed.js               # Public embed: config, retrieve, log, lead
│   │   ├── captureFields.js       # Lead capture field management
│   │   ├── categories.js          # Chatbot categories: create + assign chatbots
│   │   ├── apiData.js             # Read-only export API: categories/chatbots/messages/urls/leads across the account
│   │   ├── quizQuestions.js       # Owner-authored quiz question bank
│   │   ├── flashcards.js          # Owner-authored flashcard bank
│   │   ├── videoResources.js      # Owner-curated video recommendations
│   │   ├── analytics.js           # SQL-aggregate analytics
│   │   ├── billing.js             # Stripe checkout, portal, webhook
│   │   ├── contact.js             # Public contact-form submission
│   │   ├── admin.js               # Admin: users, tiers, audit log
│   │   ├── adminCharacters.js     # Admin: character library upload/versions
│   │   └── adminCoupons.js        # Admin: coupon CRUD + redemptions
│   └── services/
│       ├── chunk.js               # Semantic paragraph-aware chunking
│       ├── embed.js               # Gemini embedding API (single + batch, concurrency-limited)
│       ├── extract.js             # Text extraction (PDF, DOCX, TXT, images…)
│       ├── process.js             # extract → chunk → embed → persist pipeline
│       ├── processMode.js         # inline vs. Inngest background-processing mode
│       ├── stripe.js              # Stripe client factory
│       ├── url.js                 # URL fetcher + HTML cleaner
│       ├── safeFetch.js           # SSRF-safe fetch (webhooks, URL ingestion)
│       ├── rateLimitStore.js      # Shared Redis-backed express-rate-limit store
│       ├── usage.js               # Plan-limit checks + usage tracking
│       ├── vector.js              # pgvector cosine search
│       ├── tiers.js               # Chatbot capability tiers (basic/medium/advanced)
│       ├── tools.js               # Gemini function-calling tool definitions
│       ├── storage.js             # Supabase Storage signed URLs
│       ├── email.js               # SMTP transactional email (password reset, contact)
│       ├── csvImport.js           # Quiz/flashcard CSV import parsing
│       ├── coupons.js             # Coupon validation + Stripe integration
│       ├── auditLog.js            # Admin action audit trail
│       ├── accountDelete.js       # Full account + data deletion
│       ├── learner.js             # Anonymous learner-key resolution (quiz/flashcard progress)
│       ├── figures.js             # Figure/page-image resolution for RAG answers
│       └── pageImages.js          # PDF page-image rendering (@napi-rs/canvas)
├── public/
│   ├── lipsync-sdk.js             # Client SDK: Gemini Live + Rive lip-sync
│   ├── embed-loader.js            # (in js/) host-page widget loader — see below
│   ├── embed.html                 # Embeddable chat iframe
│   ├── dashboard.html             # Chatbot list
│   ├── project.html               # Per-project settings + knowledge sources
│   ├── analytics.html             # Usage charts
│   ├── billing.html                # Plan + subscription management
│   ├── account.html               # Profile settings
│   ├── admin.html                 # Admin panel shell
│   ├── docs/                      # Docs site (Introduction, SDK pages, integration guides)
│   ├── css/
│   │   ├── app.css                # Marketing/app theme (light + dark)
│   │   ├── embed.css              # Embed widget styles
│   │   ├── docs.css               # Docs site layout
│   │   └── admin.css              # Admin panel density/table overrides
│   ├── js/
│   │   ├── api.js                 # Frontend API helpers + Auth + topnav
│   │   ├── toast.js               # Shared toast implementation (app + admin)
│   │   ├── theme.js               # Light/dark theme toggle
│   │   ├── i18n.js / i18n/*.js    # Client-side i18n (en/es/fr/ar/hi)
│   │   ├── embed-loader.js        # `<script data-bot>` host-page loader
│   │   └── admin/                 # Admin panel tab modules (users, characters, coupons, tiers, audit)
│   └── assets/
│       └── characters/            # *.riv character files (not included)
├── packages/                      # Published npm SDKs — see "SDK packages" below
│   ├── js/                        # @avatar-platform/js (framework-agnostic core)
│   ├── react/                     # @avatar-platform/react (<AvatarWidget>, useAvatarPlatform)
│   ├── vue/                       # @avatar-platform/vue (<AvatarWidget> for Vue 3)
│   └── react-native/              # @avatar-platform/react-native (WebView-based)
├── scripts/
│   └── sync-version.js            # Propagates root package.json's version into packages/* + the SDK banner
├── supabase/
│   ├── schema.sql                 # Full Postgres schema (run once; idempotent to re-run)
│   └── migrations/                # Dated, standalone record of each schema change
├── .github/workflows/
│   ├── ci.yml                     # Test suite + schema.sql sanity check on push/PR
│   └── publish-sdk.yml            # Manually-triggered npm publish for packages/*
├── .env.example                   # All environment variables documented
└── package.json
```

### SDK packages

`packages/{js,react,react-native,vue}` are the source for the published `@avatar-platform/*` npm packages — thin wrappers around the same embed mechanism as the plain `<script data-bot>` snippet, documented at `/docs/js-sdk`, `/docs/react-sdk`, `/docs/vue-sdk`, and `/docs/react-native-sdk`. `npm run build:sdk` runs `scripts/sync-version.js` (propagates root `package.json`'s version into every package and into `public/lipsync-sdk.js`'s banner comment, so they can't drift independently) and then builds each package with `tsup`. Publishing itself is a manually-triggered GitHub Actions workflow (`.github/workflows/publish-sdk.yml`) — see that file's header comment for one-time npm token setup.

---

## Quick Start

```bash
# 1. Clone and install
git clone <repo> && cd avatar-platform
npm install

# 2. Configure
cp .env.example .env
# Required: set GEMINI_API_KEY, JWT_SECRET, DATABASE_URL

# 3. Set up database (once)
# → Go to Supabase project → SQL Editor → paste supabase/schema.sql → Run

# 4. Start
npm start           # production
npm run dev         # auto-restart on file changes (node --watch)
```

Open [http://localhost:8080](http://localhost:8080) — you can run without Stripe configured (billing endpoints return 503, everything else works).

---

## Environment Variables

See `.env.example` for the full annotated list. Key variables:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **Yes** | Postgres connection string (`postgresql://user:pass@host:port/db`) |
| `DATABASE_SSL` | No | Set to `false` to disable SSL (local Postgres). Default: SSL enabled. |
| `GEMINI_API_KEY` | **Yes** | Server-side key for embeddings and multimodal extraction |
| `PUBLIC_GEMINI_API_KEY` | Recommended | Separate restricted key exposed to embed pages for Gemini Live. Must not equal `GEMINI_API_KEY` (no fallback — if unset, widgets run text-only via `/ask`). Restrict it to the Live API + referrers. |
| `JWT_SECRET` | **Yes** | Secret for signing auth tokens (30-day expiry). Use a strong random string. |
| `PORT` | No | HTTP port. Default: `8080` |
| `EMBEDDING_MODEL` | No | Default: `gemini-embedding-exp-03-07` |
| `EMBEDDING_DIMENSIONS` | No | Default: `768`. If you change to `3072`, update `vector(768)` in `schema.sql` first. |
| `STRIPE_SECRET_KEY` | No | Required for billing. Omit to run in demo mode. |
| `STRIPE_WEBHOOK_SECRET` | No | Webhook signing secret from Stripe dashboard |
| `STRIPE_PRICE_STARTER` | No | Stripe price ID for the Starter plan |
| `STRIPE_PRICE_PRO` | No | Stripe price ID for the Pro plan |
| `STRIPE_PRICE_BUSINESS` | No | Stripe price ID for the Business plan |
| `SMTP_HOST` | No | SMTP server for password-reset emails |
| `SMTP_PORT` | No | Default: `587` |
| `SMTP_USER` / `SMTP_PASS` | No | SMTP credentials |
| `SMTP_FROM` | No | From address for outbound emails |
| `CONTACT_TO_EMAIL` | No | Where `/api/contact` submissions are delivered. Default: `SMTP_FROM` (or `SMTP_USER`). |
| `APP_URL` | No | Public URL for password-reset links. Default: `http://localhost:8080` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | No (recommended on Vercel) | Upstash Redis over REST — shared rate-limit store. See [Rate limiting](#rate-limiting). Without it, limiters are in-memory only. |
| `REDIS_URL` | No | Generic Redis over TCP — alternative rate-limit store. See [Rate limiting](#rate-limiting). |
| `PROCESS_MODE` | No | `inline` or `inngest` — how queued file uploads are processed. Default: `inngest` on Vercel, `inline` elsewhere. See [Background file processing](#background-file-processing-inngest--inline). |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | No (required if `PROCESS_MODE=inngest`) | Inngest app credentials. See [Background file processing](#background-file-processing-inngest--inline). |

---

## Database Setup (Supabase)

1. Create a new Supabase project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor → New query**
3. Paste the contents of `supabase/schema.sql` and click **Run**
4. Copy the **Connection string** from **Settings → Database → Connection string** (use Transaction Pooler on port 6543 for serverless, or Direct on port 5432 for persistent servers)
5. Set `DATABASE_URL` in your `.env`

The schema creates 10 tables:

| Table | Purpose |
|---|---|
| `users` | Accounts (email + bcrypt hash) |
| `projects` | Chatbot configurations (persona, widget settings, avatar placement) |
| `files` | Uploaded files and URL sources |
| `chunks` | Text chunks with `vector(768)` embeddings |
| `sessions` | Anonymous chat sessions from embed visitors |
| `messages` | Chat transcript for analytics |
| `subscriptions` | Stripe subscription records |
| `usage` | Monthly message + embedding-char counters |
| `capture_fields` | Lead capture form field definitions |
| `leads` | Collected lead data per session |
| `chatbot_categories` | User-defined groupings for chatbots (`projects.categoryId`) |

The `chunks` table has an HNSW index (`m=16, ef_construction=64`) for fast cosine similarity search via the pgvector `<=>` operator.

All foreign keys use `ON DELETE CASCADE` — deleting a user removes all their data; deleting a project removes its files, chunks, sessions, messages, capture fields, and leads.

---

## API Reference

All routes under `/api/*` return JSON. Authenticated routes require `Authorization: Bearer <token>`.

### Auth — `/api/auth`

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/signup` | `{email, password, name?}` | Create account → `{token, user}` |
| POST | `/login` | `{email, password}` | Sign in → `{token, user}` |
| GET | `/me` | — | Current user |
| PATCH | `/me` | `{name?, email?, currentPassword?, newPassword?}` | Update profile |
| DELETE | `/me` | — | Delete account + all data |
| POST | `/forgot-password` | `{email}` | Send reset email (always returns `{ok:true}`) |
| POST | `/reset-password` | `{token, newPassword}` | Consume reset token |

### Projects — `/api/projects`

| Method | Path | Description |
|---|---|---|
| GET | `/` | List all projects |
| POST | `/` | Create project |
| GET | `/:id` | Get project |
| PATCH | `/:id` | Update project settings |
| DELETE | `/:id` | Delete project (cascades) |
| POST | `/:id/duplicate` | Clone project (no files/chunks) |
| GET | `/:id/sessions` | List chat sessions with message counts |
| GET | `/:id/sessions/:sessionId` | Get session + messages |
| GET | `/:id/leads` | List leads (paginated, filterable by `complete`) |
| GET | `/:id/leads/:leadId` | Get lead + conversation |
| POST | `/:id/webhook/test` | Fire a test webhook event |

**Project fields (PATCH):** `name`, `characterId`, `systemPrompt`, `voice`, `welcomeMessage`, `categoryId` (nullable — set to move it into a category, `null` to un-categorize), `widgetPosition` (`bottom-right`|`bottom-left`|`inline`), `widgetStartOpen`, `textDirection` (`auto`|`ltr`|`rtl`), `themeColor`, `showBranding`, `showSourceCards`, `widgetOffsetX`, `widgetOffsetY`, `avatarPosition` (`left`|`right`), `avatarSize` (`small`|`medium`|`large`|`xlarge`), `showAvatarInLauncher`, `avatarOffsetX`, `avatarOffsetY`, `avatarKeepVisible`, `avatarCompactOnMobile`, `webhookUrl`

### Files & Sources — `/api/projects/:projectId/files`

| Method | Path | Description |
|---|---|---|
| GET | `/` | List files |
| POST | `/` | Upload files (multipart, up to 20 files, max 100MB each) |
| DELETE | `/:fileId` | Delete file + chunks |
| POST | `/:fileId/reprocess` | Re-extract + re-embed |
| GET | `/:fileId/status` | Polling endpoint: `{status, chunkCount, error}` |
| GET | `/:fileId/blob` | Download original file (owner only) |
| GET | `/:fileId/chunks` | List chunks (`?search=` for text filter) |
| DELETE | `/:fileId/chunks/:chunkId` | Delete a single chunk |
| POST | `/../sources/url` | Ingest URL(s): `{url}` or `{urls:[…]}` |
| POST | `/../reindex` | Re-embed all ready files with current model |

### Chatbot Categories — `/api/categories`

User-defined groupings for chatbots. A chatbot (project) belongs to at most one category (`projects.categoryId`, nullable). Assign a chatbot to a category either here (bulk) or via `PATCH /api/projects/:id { categoryId }` (one at a time, e.g. from the project settings page). Deleting a category un-categorizes its chatbots rather than deleting them.

| Method | Path | Description |
|---|---|---|
| GET | `/` | List categories, each with its chatbots nested (`id`, `name`, `publicId`, `characterId`) |
| POST | `/` | Create category `{name, color?, description?}` |
| GET | `/:id` | Get category + full chatbot rows |
| PATCH | `/:id` | Update `{name?, color?, description?}` |
| DELETE | `/:id` | Delete category (chatbots become uncategorized) |
| POST | `/:id/chatbots` | Bulk-assign `{projectIds: [uuid, …]}` |
| DELETE | `/:id/chatbots/:projectId` | Unassign one chatbot from this category |

`GET /api/projects` also accepts `?categoryId=` to filter the list, and `POST /api/projects` accepts an optional `categoryId` at creation time.

### Data Export API — `/api/data`

Read-only endpoints for pulling everything an account has — across **every** chatbot, not just one — into another platform. Same `Authorization: Bearer <token>` auth as the rest of `/api/*`; every query is scoped to the caller's own account.

| Method | Path | Description |
|---|---|---|
| GET | `/categories` | Every category, each with its chatbots nested |
| GET | `/chatbots` | Every chatbot; `?categoryId=` filters |
| GET | `/messages` | Every chat message across every chatbot; `?projectId=&categoryId=&page=&limit=` |
| GET | `/urls` | Every URL knowledge source (`files.kind = 'url'`) across every chatbot; `?projectId=&categoryId=&page=&limit=` |
| GET | `/leads` | Every lead across every chatbot; `?projectId=&categoryId=&complete=true\|false&page=&limit=` |

`messages`, `urls`, and `leads` are paginated (`page`/`limit`, default 50, max 200) and return `{ [resource], total, page, limit }`. Each row is enriched with its parent chatbot's name and category (`chatbotName`, `categoryId`, `categoryName`) so a consumer doesn't need to join against `/api/data/chatbots` itself.

### Capture Fields — `/api/projects/:projectId/capture`

| Method | Path | Description |
|---|---|---|
| GET | `/` | List fields (ordered) |
| POST | `/` | Create field `{label, key, type, options?, required?, order?}` |
| PATCH | `/:fieldId` | Update field |
| DELETE | `/:fieldId` | Delete field |
| POST | `/reorder` | Reorder: `{ids: [uuid, …]}` |

**Allowed types:** `text`, `email`, `phone`, `number`, `date`, `time`, `select`

### Analytics — `/api/analytics`

| Method | Path | Description |
|---|---|---|
| GET | `/overview` | Totals + 30-day daily chart + per-project breakdown |
| GET | `/project/:id` | Project-level totals + daily chart + top questions |

### Billing — `/api/billing`

| Method | Path | Description |
|---|---|---|
| GET | `/plans` | List all plans (public) |
| GET | `/subscription` | Current plan + subscription status |
| GET | `/usage` | Current period usage vs limits |
| POST | `/create-checkout-session` | `{planId}` → Stripe Checkout URL |
| POST | `/create-portal-session` | Stripe Customer Portal URL |
| POST | `/webhook` | Stripe webhook (raw body, handles subscription lifecycle) |

### Embed (Public) — `/embed/:publicId`

No auth required. Rate-limited at 30 req/min per IP+project.

| Method | Path | Description |
|---|---|---|
| GET | `/config` | Full widget config (project settings, character, capture fields, API key) |
| POST | `/retrieve` | `{query, k?}` → top-K RAG chunks + source metadata |
| POST | `/log` | `{sessionId?, role, text}` → logs message, returns `{sessionId}` |
| GET | `/capture-fields` | Public capture field definitions |
| POST | `/lead` | `{sessionId, data, complete?}` → upserts lead record |
| GET | `/file/:fileId` | Serve image file (only images; PDFs/docs blocked) |

---

## Embed Widget

Drop this on any page to add the chatbot:

```html
<script
  src="https://your-host.com/lipsync-sdk.js"
  data-public-id="YOUR_PROJECT_PUBLIC_ID"
  async>
</script>
```

The SDK auto-boots the widget. For inline mode (full-page embed in an iframe):

```html
<iframe src="https://your-host.com/embed?id=YOUR_PUBLIC_ID&mode=inline" />
```

### Widget Customization

All settings are controlled from the dashboard (Project → Widget tab). Available per-project:

**Layout:** position (bottom-right / bottom-left / inline), start open/closed, x/y offset

**Avatar:** position in panel (left/right), size (small 80px / medium 120px / large 160px / xlarge 200px), show in launcher, keep visible during AI speech, compact on mobile

**Theme:** accent color, show/hide branding watermark, show/hide source citation cards, text direction (auto/ltr/rtl)

### Webhook

Set a webhook URL on any project to receive real-time events. Each request is signed with `X-Avatar-Signature: sha256=<hmac>` using the project's webhook secret.

```json
{
  "event": "message",
  "publicId": "abc123",
  "sessionId": "uuid",
  "role": "user",
  "text": "Hello!",
  "timestamp": 1747221600000
}
```

---

## Plans & Billing

Four tiers defined in `backend/plans.js`:

| Plan | Price | Projects | Files/project | Messages/mo | Storage |
|---|---|---|---|---|---|
| Free | $0 | 3 | 5 | 100 | 50 MB |
| Starter | $19 | 3 | 25 | 2,000 | 500 MB |
| Pro | $59 | 10 | 100 | 10,000 | 5 GB |
| Business | $199 | 50 | 500 | 100,000 | 50 GB |

Limits are enforced server-side before uploads, project creation, and message logging.

To enable Stripe billing:
1. Create products + recurring prices in [Stripe Dashboard](https://dashboard.stripe.com/products)
2. Set `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` in `.env`
3. Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
4. Register `https://your-host.com/api/billing/webhook` in Stripe Webhooks with events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`

---

## Character Files

Drop Rive files at:

```
public/assets/characters/character_1.riv   → Aria (default)
public/assets/characters/character_2.riv   → Kai
public/assets/characters/character_3.riv   → Nova
public/assets/characters/character_4.riv   → Echo
```

All character files must use the **`Character`** artboard with an **`InLesson`** state machine and viseme number inputs **100–122**. This is the interface the `lipsync-sdk.js` drives for lip-sync.

---

## Deployment

### Environment

The server is a plain Node.js process. Any host that runs Node ≥ 18 works: Railway, Render, Fly.io, AWS App Runner, a VPS, etc.

```bash
npm start   # runs: node backend/server.js
```

### Health check

```
GET /healthz  →  {"ok": true, "uptime": 123.4}
```

### Supabase SSL

The `pg` driver is configured with `{ rejectUnauthorized: false }` by default to allow Supabase's managed TLS. Set `DATABASE_SSL=false` only for a local Postgres instance without TLS.

### File uploads

Uploaded files are stored on the local filesystem at `data/uploads/<projectId>/`. In a multi-instance deployment, point this path at a shared volume or swap `multer.diskStorage` for S3/GCS storage.

### Background file processing (Inngest / inline)

Once a file finishes uploading, `routes/files.js`'s `queueProcessing()` runs the extract → chunk → embed pipeline (`services/process.js`'s `processFile`) in one of two modes, picked by `backend/services/processMode.js`:

| Mode | How it runs | When to use |
|---|---|---|
| `inline` (default off Vercel) | `setImmediate(() => processFile(fileRecord))` — right in the process that queued it | The default for a plain `npm start`/`npm run dev` deployment. Zero external setup. **Not safe on Vercel** — a serverless function is frozen shortly after its response is sent, so a still-running inline job can be cut off mid-pipeline, leaving the file stuck in `processing`. |
| `inngest` (default on Vercel) | Durable background job via [Inngest](https://www.inngest.com) (`backend/inngest/functions.js`), invoked back into this app per step through `POST /api/inngest` | Any deployment where the process doesn't stay alive after the response — Vercel, or multi-instance setups that want retries. |

Set `PROCESS_MODE=inline` or `PROCESS_MODE=inngest` to override the auto-detected default (`VERCEL` env var set → `inngest`, otherwise `inline`).

To actually configure Inngest on Vercel:
1. Create an app at [inngest.com](https://www.inngest.com) and grab its **Event Key** and **Signing Key**.
2. Set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in your Vercel project's environment variables.
3. Deploy, then in the Inngest dashboard point its "Sync app" at `https://your-deployment.com/api/inngest` — Inngest calls this URL to discover and invoke `process-file` (the one function in `backend/inngest/functions.js`).

If `PROCESS_MODE` resolves to `inngest` (explicitly or by Vercel auto-detection) and neither `INNGEST_EVENT_KEY` nor `INNGEST_SIGNING_KEY` is set, the server logs a warning at boot: uploads will queue events nothing is listening for and sit in `processing` forever until this is fixed.

### Rate limiting

All express-rate-limit instances (`authLimiter`, `apiLimiter`, `embedLimiter`, `adminLoginLimiter` in `backend/server.js`, plus the per-visitor AI-cost limiters on `/embed/:publicId/ask`, `/study`, and `/retrieve` in `backend/routes/embed.js`) share one Redis-backed store via `backend/services/rateLimitStore.js` when one is configured. Without it they fall back to per-process MemoryStore and a loud warning is logged at boot — on Vercel that means limits reset on every cold invocation and are effectively disabled, so **configure a store before serving real traffic**:

| Variable | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis over REST. Recommended for Vercel — pure HTTP, no TCP connection state to lose between serverless invocations. (`UPSTASH_REDIS_URL`/`UPSTASH_REDIS_TOKEN` are accepted aliases.) |
| `REDIS_URL` | Any Redis over TCP (`redis://…`, or `rediss://…` for TLS, e.g. Upstash's TCP or Railway Redis). Used when the Upstash REST vars are unset. |

Keying:
- Each limiter writes under its own key prefix (`ratelimit:auth:…`, `ratelimit:api:…`, …) so counters never collide in the shared keyspace.
- `embedLimiter` keys by **IP + publicId**, so one visitor behind a shared NAT IP no longer throttles every other embed served to that IP, and abuse is scoped per chatbot. IPv6 clients are normalized to a /56 prefix (`ipKeyGenerator`) to prevent low-order-bit rotation bypasses.
- The AI-cost limiters additionally cap at 10 req/min per IP + project, independent of the generic 30/min embed limit.
- Store failures fail open: if Redis errors, express-rate-limit's `passOnStoreError` lets the request through and logs the error — rate limiting degrades to "off" instead of 500s.

### Scaling notes

- **Vector search** uses pgvector HNSW — fast at millions of chunks, no external vector DB needed.
- **Usage tracking** uses SQL `ON CONFLICT` upserts — safe under concurrent load.
- **Rate limiting** is shared through Redis (see "Rate limiting" above); without a Redis store it degrades to in-memory per instance.
- **Background processing** uses Inngest by default on Vercel, and an in-process `setImmediate` fallback everywhere else — see "Background file processing (Inngest / inline)" above. `PROCESS_MODE=inngest` on any deployment gets durable retries even off Vercel.
