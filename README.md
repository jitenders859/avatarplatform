# AvatarPlatform

A multi-tenant SaaS platform for embedding AI talking-character chatbots on any website. Built around a Rive runtime for real-time lip-sync, Gemini Live for speech-to-speech conversation, and `text-embedding-004` for RAG retrieval over uploaded files and URLs.

## What's in this build

- **Auth** — signup, login, JWT, protected routes
- **Projects** — multi-chatbot per user, each with its own character / voice / persona
- **Knowledge sources** — upload PDFs, DOCX, TXT, MD, CSV, JSON, HTML, images, audio, video. Or paste URLs and we'll fetch + clean them.
- **RAG retrieval** — Google `text-embedding-004`, in-memory cosine search per project, source-card citations in chat.
- **Floating widget** — bottom-right or bottom-left, minimize/maximize, smooth open/close animations, RTL support, auto-language detection, loading skeleton.
- **Plans + billing** — 4 tiers (Free / Starter / Pro / Business) with usage tracking and limit enforcement. Stripe checkout + Customer Portal + webhook handlers ready to plug in.
- **Analytics** — last-30-day message chart, per-bot breakdown, usage snapshots.
- **Drop-in embed** — one `<script>` tag on any site.

## Quick start

```bash
git clone … && cd avatar-platform
cp .env.example .env
# edit .env — at minimum set GEMINI_API_KEY and JWT_SECRET
npm install
npm start
# open http://localhost:8080
```

You can run the server without `STRIPE_SECRET_KEY` — billing endpoints will return 503 and the UI will show a "demo mode" notice. Everything else works.

## Adding character files

Drop your Rive files at:

```
public/assets/characters/character_1.riv
public/assets/characters/character_2.riv
public/assets/characters/character_3.riv
public/assets/characters/character_4.riv
```

All four characters must use the **`Character`** artboard with **`InLesson`** state machine and viseme inputs **100–122**. (This is the format the `lipsync-sdk.js` is wired for.)

## Setting up Stripe (when you're ready)

1. **Create products + prices** in [Stripe Dashboard → Products](https://dashboard.stripe.com/products). For each plan, add a recurring monthly price.
2. **Copy the `price_…` IDs** into `.env`:
   ```
   STRIPE_PRICE_STARTER=price_1AbcDe…
   STRIPE_PRICE_PRO=price_1FghIj…
   STRIPE_PRICE_BUSINESS=price_1KlmNo…
   ```
3. **Add your secret key**:
   ```
   STRIPE_SECRET_KEY=sk_live_…   (or sk_test_… while testing)
   ```
4. **Create a webhook** in [Dashboard → Webhooks → Add endpoint](https://dashboard.stripe.com/webhooks):
   - Endpoint URL: `https://your-host.com/api/billing/webhook`
   - Events to send: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
5. Restart the server.

For local testing, use the Stripe CLI:
```bash
stripe listen --forward-to localhost:8080/api/billing/webhook
# CLI will print a webhook secret — paste it as STRIPE_WEBHOOK_SECRET
stripe trigger checkout.session.completed
```

## Plan limits

| Plan      | Bots | Files | Storage | Msgs/mo  | URL sources |
|-----------|------|-------|---------|----------|-------------|
| Free      | 1    | 5     | 50 MB   | 100      | 3           |
| Starter   | 3    | 25    | 500 MB  | 2,000    | 25          |
| Pro       | 10   | 100   | 5 GB    | 10,000   | 200         |
| Business  | 50   | 500   | 50 GB   | 100,000  | 2,000       |

Limits are enforced server-side; failed checks return HTTP 402 with a message the UI surfaces as a toast linking to `/billing`.

## Embed the widget

After publishing a chatbot, copy the script snippet from the **Embed** tab:

```html
<script src="https://your-host.com/js/embed-loader.js"
        data-bot="YOUR_PUBLIC_ID" defer></script>
```

The loader reads the project's `widgetPosition`, `themeColor`, etc. from the public config endpoint, places an iframe at the right corner, and resizes it on open/close via `postMessage`.

For full inline mode (no floating launcher), add `data-mode="inline"`.

## Architecture

```
backend/
  server.js              Express entry (Stripe webhook mounted with raw body before JSON parser)
  db.js                  JSON-file DB with atomic writes + per-table lock
  plans.js               Plan tiers + limits + Stripe price ID mapping
  middleware/auth.js     JWT verify
  routes/
    auth.js              signup / login / me
    projects.js          CRUD + characters list + widget settings
    files.js             multer uploads + URL ingestion + plan-limit enforcement
    embed.js             public config + RAG retrieve + log + image preview
    billing.js           plans / checkout / portal / webhook
    analytics.js         30-day rollup
  services/
    extract.js           PDF/DOCX/TXT/multimodal (image, audio, video) via Gemini 2.0 Flash
    url.js               fetch + cheerio clean + extract
    chunk.js             paragraph→sentence→space chunking
    embed.js             text-embedding-004 (768-dim, batched)
    vector.js            cosine similarity
    process.js           extract → chunk → embed → persist
    stripe.js            lazy-init wrapper
    usage.js             tracking + checkLimit

public/
  index.html             marketing landing
  pricing.html           plans (public)
  login.html, signup.html
  dashboard.html         project list
  project.html           5-tab editor: Settings, Knowledge, Widget, Preview, Embed
  billing.html           plan grid + usage bars
  analytics.html         totals + 30-day chart + per-project rollup
  embed.html             public chat widget (loaded inside iframe)
  css/app.css            premium dark SaaS theme
  css/embed.css          floating widget styling + RTL + animations
  js/api.js              fetch wrapper + Auth + topnav + toast
  js/embed-loader.js     drop-in script for third-party sites
  lipsync-sdk.js         the Rive + Gemini Live SDK (verbatim from the user's repo)
```

## Notes

- **`PUBLIC_GEMINI_API_KEY` exposure**: the SDK requires a key client-side to open the Gemini Live websocket. Use a RESTRICTED key with quotas in production. A future version could proxy the websocket through this server.
- **Vector store** is in-memory (computed on demand from the `chunks` table). For 10k+ chunks per project, swap `services/vector.js` for sqlite-vec, pgvector, or Pinecone.
- **DB** is JSON-file based — fine for small scale, swap for Postgres later by reimplementing `db.js`'s exported surface.
- **Sessions** track anonymous visitors per IP per project. Use `/api/analytics/overview` to see usage rollups.

## What's not in this build (intentionally)

- Forgot/reset password (needs an email service — SendGrid, Resend, SES — pick one and add).
- A multi-step builder wizard (the project editor's tabs cover the same ground in fewer clicks).
- Per-message granular streaming chunking (the SDK already streams the first word as soon as it arrives; we don't add another layer).
- Translated UI strings (we support RTL direction; full i18n is a separate sprint).
