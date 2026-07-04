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
1. Visitor types a message → `embed.html` calls `POST /embed/:id/retrieve`
2. Server embeds the query with Gemini, runs pgvector cosine search, returns top-K chunks
3. Chunks injected into Gemini Live SDK's `knowledgeBase` — AI answers with RAG context
4. Transcript logged via `POST /embed/:id/log` for analytics and webhooks

---

## Directory Structure

```
avatar-platform/
├── backend/
│   ├── server.js                  # Express entry point
│   ├── db.js                      # Postgres layer (pg.Pool, camelCase↔snake_case)
│   ├── plans.js                   # Plan definitions + limits
│   ├── middleware/
│   │   └── auth.js                # JWT authRequired middleware + signToken
│   ├── routes/
│   │   ├── auth.js                # Signup, login, reset password, /me
│   │   ├── projects.js            # Project CRUD, sessions, leads
│   │   ├── files.js               # File upload, URL ingest, chunks viewer
│   │   ├── embed.js               # Public embed: config, retrieve, log, lead
│   │   ├── captureFields.js       # Lead capture field management
│   │   ├── analytics.js           # SQL-aggregate analytics
│   │   └── billing.js             # Stripe checkout, portal, webhook
│   └── services/
│       ├── chunk.js               # Semantic paragraph-aware chunking
│       ├── embed.js               # Gemini embedding API (single + batch)
│       ├── extract.js             # Text extraction (PDF, DOCX, TXT, images…)
│       ├── process.js             # Background: extract → chunk → embed → persist
│       ├── stripe.js              # Stripe client factory
│       ├── url.js                 # URL fetcher + HTML cleaner
│       ├── usage.js               # Plan-limit checks + usage tracking
│       └── vector.js              # pgvector cosine search
├── public/
│   ├── lipsync-sdk.js             # Client SDK: Gemini Live + Rive lip-sync
│   ├── embed.html                 # Embeddable chat iframe
│   ├── dashboard.html             # Chatbot list
│   ├── project.html               # Per-project settings + knowledge sources
│   ├── analytics.html             # Usage charts
│   ├── billing.html               # Plan + subscription management
│   ├── account.html               # Profile settings
│   ├── css/
│   │   └── embed.css              # Embed widget styles (dark theme)
│   ├── js/
│   │   └── api.js                 # Frontend API helpers + Auth + toast + topnav
│   └── assets/
│       └── characters/            # *.riv character files (not included)
├── supabase/
│   └── schema.sql                 # Full Postgres schema (run once in Supabase)
├── .env.example                   # All environment variables documented
└── package.json
```

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
| `PUBLIC_GEMINI_API_KEY` | Recommended | Separate restricted key exposed to embed pages for Gemini Live. Falls back to `GEMINI_API_KEY`. |
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
| `APP_URL` | No | Public URL for password-reset links. Default: `http://localhost:8080` |

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

**Project fields (PATCH):** `name`, `characterId`, `systemPrompt`, `voice`, `welcomeMessage`, `widgetPosition` (`bottom-right`|`bottom-left`|`inline`), `widgetStartOpen`, `textDirection` (`auto`|`ltr`|`rtl`), `themeColor`, `showBranding`, `showSourceCards`, `widgetOffsetX`, `widgetOffsetY`, `avatarPosition` (`left`|`right`), `avatarSize` (`small`|`medium`|`large`|`xlarge`), `showAvatarInLauncher`, `avatarOffsetX`, `avatarOffsetY`, `avatarKeepVisible`, `avatarCompactOnMobile`, `webhookUrl`

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

### Scaling notes

- **Vector search** uses pgvector HNSW — fast at millions of chunks, no external vector DB needed.
- **Usage tracking** uses SQL `ON CONFLICT` upserts — safe under concurrent load.
- **Rate limiting** is in-memory per server instance. For multi-instance deployments, swap the `buckets` Map in `routes/embed.js` for Redis.
- **Background processing** (`processFileAsync`) uses `setImmediate` — fine for single-instance. For heavier workloads, move to a job queue (BullMQ).
