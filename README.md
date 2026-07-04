# AvatarPlatform

A multi-tenant SaaS platform for embedding AI talking-character chatbots on any website. Built around a Rive runtime for real-time lip-sync, Gemini Live for speech-to-speech conversation, and `text-embedding-004` for RAG retrieval over uploaded files and URLs.

## What's in this build

- **Auth** — signup, login, JWT, forgot/reset password flows
- **Projects** — multi-chatbot per user, each with its own character, voice, and persona
- **Knowledge sources** — upload PDFs, DOCX, TXT, MD, CSV, JSON, HTML, images, audio, video; or paste URLs to fetch + clean automatically
- **RAG retrieval** — Google `text-embedding-004` (768-dim), in-memory cosine search per project, source-card citations in chat
- **Gemini Live voice chat** — real-time speech-to-speech via WebSocket; viseme stream drives Rive lip-sync
- **Async Q&A** — `POST /embed/:publicId/ask` for text-only chat without a WebSocket (Gemini 2.0 Flash REST)
- **Floating widget** — bottom-right or bottom-left anchor, minimize/maximize, RTL support, auto-language detection, smooth animations
- **Lead capture** — configurable capture fields per project; collected into a `leads` table with session linkage
- **Plans + billing** — 4 tiers (Free / Starter / Pro / Business), usage tracking, limit enforcement; Stripe checkout + Customer Portal + webhooks
- **Analytics** — last-30-day message chart, per-bot breakdown, usage snapshots
- **Drop-in embed** — one `<script>` tag with `data-bot` attribute
- **React SDK** — `<AvatarWidget>` component + `useAvatarPlatform()` hook (`/sdk/react.js`)
- **Docs site** — full 9-page documentation at `/docs`
- **Marketing site** — homepage, pricing, characters, contact (cal.com booking), terms of service

## Quick start

```bash
git clone … && cd avatar-platform
cp .env.example .env
# edit .env — at minimum set GEMINI_API_KEY and JWT_SECRET
npm install
npm start
# open http://localhost:8080
```

You can run without `STRIPE_SECRET_KEY` — billing endpoints return 503 and the UI shows a "demo mode" notice. Everything else works.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Used server-side for embeddings, extraction, and async Q&A |
| `PUBLIC_GEMINI_API_KEY` | Recommended | Served to the client for Gemini Live WebSocket (use a restricted key with quotas) |
| `JWT_SECRET` | Yes | Signs auth tokens |
| `STRIPE_SECRET_KEY` | Optional | Enables billing endpoints |
| `STRIPE_WEBHOOK_SECRET` | Optional | Validates Stripe webhook signatures |
| `STRIPE_PRICE_STARTER` | Optional | `price_…` ID for the Starter plan |
| `STRIPE_PRICE_PRO` | Optional | `price_…` ID for the Pro plan |
| `STRIPE_PRICE_BUSINESS` | Optional | `price_…` ID for the Business plan |
| `PORT` | Optional | Defaults to `8080` |

## Adding character files

Drop your Rive files at:

```
public/assets/characters/character_1.riv
public/assets/characters/character_2.riv
public/assets/characters/character_3.riv
public/assets/characters/character_4.riv
```

All characters must use the **`Character`** artboard with **`InLesson`** state machine and viseme inputs **100–122**. This is the format `lipsync-sdk.js` is wired for.

## Embed the widget

After publishing a chatbot, copy the snippet from the **Embed** tab:

```html
<script src="https://your-host.com/lipsync-sdk.js"
        data-public-id="YOUR_PUBLIC_ID" defer></script>
```

### Async Q&A (no voice)

Use `AvatarPlatform.ask()` from the same SDK for text-only interactions:

```js
const { answer, sources, sessionId } = await AvatarPlatform.ask('YOUR_PUBLIC_ID', 'What is your return policy?');
```

Prefetch the config before the widget opens to eliminate first-load latency:

```js
AvatarPlatform.preload('YOUR_PUBLIC_ID');
```

### React SDK

```jsx
import { AvatarWidget, useAvatarPlatform } from 'https://your-host.com/sdk/react.js';

function App() {
  const { ask, open } = useAvatarPlatform('YOUR_PUBLIC_ID');
  return <AvatarWidget botId="YOUR_PUBLIC_ID" position="bottom-right" theme="#6366f1" />;
}
```

See `/docs/react-sdk` or `public/sdk/README.md` for the full API.

## Setting up Stripe

1. Create products + prices in [Stripe Dashboard → Products](https://dashboard.stripe.com/products). Add a recurring monthly price for each paid plan.
2. Copy the `price_…` IDs into `.env` (see table above).
3. Create a webhook in [Dashboard → Webhooks](https://dashboard.stripe.com/webhooks):
   - Endpoint URL: `https://your-host.com/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Restart the server.

For local testing:
```bash
stripe listen --forward-to localhost:8080/api/billing/webhook
stripe trigger checkout.session.completed
```

## Plan limits

| Plan     | Bots | Files | Storage | Msgs/mo | URL sources |
|----------|------|-------|---------|---------|-------------|
| Free     | 1    | 5     | 50 MB   | 100     | 3           |
| Starter  | 3    | 25    | 500 MB  | 2,000   | 25          |
| Pro      | 10   | 100   | 5 GB    | 10,000  | 200         |
| Business | 50   | 500   | 50 GB   | 100,000 | 2,000       |

Limits are enforced server-side. Failed checks return HTTP 402; the UI surfaces this as a toast linking to `/billing`.

## Architecture

```
backend/
  server.js              Express entry — Stripe webhook raw body mounted before JSON parser
  db.js                  JSON-file DB with atomic writes + per-table locks
  plans.js               Plan tiers, limits, Stripe price ID mapping
  middleware/auth.js     JWT verify middleware
  routes/
    auth.js              signup / login / me / forgot-password / reset-password
    projects.js          CRUD + characters list + widget settings
    files.js             multer uploads + URL ingestion + plan-limit enforcement
    embed.js             public config / RAG retrieve / async ask / log / image preview / leads
    captureFields.js     per-project lead capture field CRUD
    billing.js           plans / checkout / portal / webhook
    analytics.js         30-day rollup
  services/
    extract.js           PDF/DOCX/TXT/multimodal (image, audio, video) via Gemini 2.0 Flash
    url.js               fetch + cheerio clean + extract
    chunk.js             paragraph → sentence → space chunking
    embed.js             text-embedding-004 (768-dim, batched)
    vector.js            cosine similarity search
    process.js           extract → chunk → embed → persist pipeline
    stripe.js            lazy-init Stripe wrapper
    usage.js             trackMessage + checkLimit

public/
  index.html             marketing landing page
  pricing.html           public plans page
  characters.html        character gallery
  contact.html           contact info + cal.com booking embed
  terms.html             terms of service
  login.html             
  signup.html            
  forgot-password.html   
  reset-password.html    
  dashboard.html         project list
  project.html           5-tab editor: Settings / Knowledge / Widget / Preview / Embed
  billing.html           plan grid + usage bars
  analytics.html         totals + 30-day chart + per-project rollup
  embed.html             public chat widget (standalone page / iframe)
  docs/
    index.html           Introduction + quick start
    react-sdk.html       <AvatarWidget> props + useAvatarPlatform hook
    react-native-sdk.html WebView approach + headless API
    elevenlabs-avatar.html ElevenLabs voice integration
    gemini-live.html     WebSocket pipeline + viseme mapping
    openai-realtime.html OpenAI Realtime API integration
    natural-lipsync.html Amplitude + phoneme lip-sync tuning
    prefetching.html     AP.preload() / AP.ask() + widget events
    troubleshooting.html 8 common issues with fixes
  sdk/
    react.js             Browser-compatible ES module (AvatarWidget + useAvatarPlatform)
    README.md            npm package docs for @avatar-platform/react
  css/
    app.css              Dark SaaS theme (shared across all app pages)
    docs.css             Two-column docs layout + callouts + props tables
    embed.css            Floating widget + RTL + animations
  js/
    api.js               Fetch wrapper + Auth + renderTopNav + toast
    audio-clock.js       Precise audio scheduling
    hybrid-lipsync-controller.js  Phoneme + amplitude hybrid controller
    viseme-map.js        Phoneme → Rive viseme input mapping
    amplitude-fallback.js Amplitude-based fallback for browsers without mic
  lipsync-sdk.js         Rive + Gemini Live SDK + AvatarPlatform.ask/preload IIFE
```

## API reference

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/signup` | — | Create account |
| POST | `/api/auth/login` | — | Returns JWT |
| GET | `/api/auth/me` | JWT | Current user |
| POST | `/api/auth/forgot-password` | — | Send reset email |
| POST | `/api/auth/reset-password` | — | Consume reset token |
| GET | `/api/projects` | JWT | List projects |
| POST | `/api/projects` | JWT | Create project |
| PUT | `/api/projects/:id` | JWT | Update project settings |
| DELETE | `/api/projects/:id` | JWT | Delete project |
| GET | `/api/projects/characters` | JWT | List available characters |
| POST | `/api/projects/:id/files` | JWT | Upload file (multipart) |
| POST | `/api/projects/:id/sources/url` | JWT | Ingest URL |
| DELETE | `/api/projects/:id/files/:fid` | JWT | Delete file |
| GET | `/api/billing/plans` | — | Plan definitions |
| POST | `/api/billing/checkout` | JWT | Start Stripe checkout |
| POST | `/api/billing/portal` | JWT | Open Stripe Customer Portal |
| POST | `/api/billing/webhook` | Stripe sig | Handle subscription events |
| GET | `/api/analytics/overview` | JWT | 30-day rollup |
| GET | `/embed/:publicId/config` | — | Public bot config + API key |
| POST | `/embed/:publicId/retrieve` | — | RAG vector search (rate-limited) |
| POST | `/embed/:publicId/ask` | — | Async Q&A via Gemini 2.0 Flash (rate-limited) |
| POST | `/embed/:publicId/log` | — | Log a conversation message |
| POST | `/embed/:publicId/lead` | — | Upsert lead capture data |
| GET | `/embed/:publicId/file/:fid` | — | Serve image file |

## Notes

- **`PUBLIC_GEMINI_API_KEY`**: the Gemini Live WebSocket is opened client-side and requires a key. Use a key restricted by HTTP referrer and with per-minute quotas in production. A future version could proxy the WebSocket through this server.
- **Vector store**: in-memory cosine search, computed on demand from the `chunks` table. For 10k+ chunks per project, replace `services/vector.js` with sqlite-vec, pgvector, or Pinecone.
- **Database**: JSON-file based with per-table atomic writes — fine for early scale. Swap for Postgres by reimplementing the exported surface of `db.js`.
- **Sessions**: anonymous visitors are tracked per IP per project. The analytics API rolls them up into 30-day charts.
- **cal.com booking**: `contact.html` has a `CAL_USERNAME` JS variable at the top of the script block. Replace `'YOUR_CAL_USERNAME'` with your actual cal.com username to enable inline booking.

## What's not in this build (intentionally)

- Email delivery for password reset (add SendGrid, Resend, or SES and wire into `routes/auth.js`).
- Per-message streaming in async mode (the Gemini Live WebSocket already streams first words immediately; `POST /ask` is for fire-and-forget use cases).
- Full i18n strings (RTL layout is supported; translated UI is a separate sprint).
- Published npm packages for `@avatar-platform/react` and `@avatar-platform/react-native` (the docs and SDK module document the API; publishing is a separate step).
