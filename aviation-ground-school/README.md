# Ground School AI

Country- and license-specific AI ground-school chatbots for pilot training (PPL, CPL, ATPL, multi-engine and
instrument ratings), with a paid marketplace of human flight instructors on top. This is an independent
project living inside the AvatarPlatform repo, in its own `aviation-ground-school/` folder — separate stack,
separate deploy, no shared code with the rest of the repo.

## How the product works

1. **Pick a chatbot.** A student selects their country and the license/rating they're training for
   (`/onboarding`). Each `(country, licenseType)` pair maps to one `Chatbot` row with its own system prompt
   grounded in that country's actual regulator (FAA, Transport Canada, UK CAA, CASA, DGCA — see
   `prisma/seed.ts`), so "US CPL" and "Canada CPL" are answered against different rulebooks.
2. **Free trial, then paywall.** Every student gets `FREE_CHAT_MESSAGE_LIMIT` (default 20) messages, in total
   across the whole platform, before they need an active subscription. The chat API returns `402` with
   `code: "PAYWALL"` once the limit is hit and no subscription is active; the frontend then shows a Stripe
   Checkout link (`/pricing`) for a monthly or annual plan.
3. **Instructor hand-off.** Every chatbot reply comes back with a few recommended instructors who teach that
   exact country/license combo (best-rated first). Instructors are a separate purchase from the chatbot
   subscription — no subscription is required to book one.
4. **Free first session, then paid.** A student's first-ever booking with a given instructor is free, up to
   `FREE_INSTRUCTOR_SESSION_MINUTES` (default 30). Anything beyond that — or any booking after the first — is
   billed at the instructor's own hourly rate *plus* a platform commission (`PLATFORM_COMMISSION_BPS`, default
   15%) that the student pays on top. Payment is a single Stripe Checkout charge split via **Stripe Connect**:
   the platform's cut is collected as an `application_fee_amount` and the rest transfers straight to the
   instructor's connected account. See `src/lib/pricing.ts` (`splitInstructorRate`) and
   `src/app/api/bookings/route.ts`.

## Stack

- **Next.js 14** (App Router, TypeScript) — full-stack: pages + API routes in one app.
- **PostgreSQL + Prisma** — see `prisma/schema.prisma` for the full data model (countries, license types,
  chatbots, chat sessions/messages, subscriptions, instructors, availability slots, bookings).
- **Anthropic Claude** (`@anthropic-ai/sdk`) — the chatbot's brain; system prompt built per country/license
  in `prisma/seed.ts`, called from `src/lib/claude.ts`.
- **Stripe** — subscriptions for the chatbot paywall (`src/app/api/subscriptions/*`,
  `src/app/api/webhooks/stripe`) and **Stripe Connect Express** for instructor payouts + commission
  (`src/app/api/instructors/connect/*`, `src/app/api/webhooks/stripe-connect`, `src/app/api/bookings/*`).
- Hand-rolled JWT cookie auth (`src/lib/auth.ts`) — no third-party auth provider, kept intentionally simple.

## Getting started

```bash
cd aviation-ground-school
npm install
cp .env.example .env   # fill in DATABASE_URL, ANTHROPIC_API_KEY, STRIPE_* — see comments in the file
npm run db:generate
npm run db:migrate     # creates the schema in your Postgres database
npm run db:seed        # loads countries, license types, and the chatbot catalog
npm run dev
```

Open http://localhost:3000.

### Stripe setup

You need **two separate webhook endpoints** registered in the Stripe dashboard, each with its own signing
secret:

- `POST /api/webhooks/stripe` — regular account events: `customer.subscription.*` (paywall),
  `checkout.session.completed` / `checkout.session.expired` (instructor booking payments). Secret goes in
  `STRIPE_WEBHOOK_SECRET`.
- `POST /api/webhooks/stripe-connect` — **with "Listen to events on Connected accounts" enabled** —
  `account.updated`, used to flip `Instructor.connectOnboarded` once an instructor finishes Connect
  onboarding. Secret goes in `STRIPE_CONNECT_WEBHOOK_SECRET`.

Create two Prices in Stripe (monthly + annual) for the chatbot subscription and put their IDs in
`STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_ANNUAL`.

## Project layout

```
prisma/schema.prisma        Data model
prisma/seed.ts               Countries, license types, chatbot system prompts
src/lib/                     Server-side building blocks (db, auth, claude, stripe, pricing, instructors)
src/app/api/                 Route Handlers — the whole backend
src/app/                     Pages (App Router)
src/components/              Small client components shared across pages
```

## Notable product assumptions baked into the code

These were judgment calls made to ship a coherent v1 — revisit them as the real product spec firms up:

- The free chatbot message limit is **per platform**, not per chatbot — a student who exhausts it on the US
  CPL bot is also paywalled on the Canada PPL bot (`ChatSession.freeMessagesUsed` is tracked per session, the
  gate check itself just isn't relaxed per-chatbot; adjust in
  `src/app/api/chat/sessions/[id]/messages/route.ts` if you want per-chatbot trials instead).
- "First session free" is scoped **per instructor**, not once platform-wide — a student gets a free trial
  session with every new instructor they try (`src/lib/instructors.ts#hasPriorBooking`).
- If a free trial slot is longer than `FREE_INSTRUCTOR_SESSION_MINUTES`, only the extra time is billed (see
  `POST /api/bookings`) rather than the whole session becoming free or paid.
- A `User` can hold both a student and an instructor profile at once (the `Instructor` model wraps a `User`
  rather than replacing it); `User.role` flips to `INSTRUCTOR` the first time someone creates an instructor
  profile, but that's advisory only — it doesn't gate any student-side feature.

## What's intentionally not built yet

- Instructor rating/review submission (the `ratingAvg`/`ratingCount` columns exist and are read, but nothing
  writes them yet — wire this up once sessions can be marked `COMPLETED`).
- Actual video/call delivery for booked sessions (booking records + payment are real; the call itself needs a
  provider — Zoom, Daily, Twilio Video, etc. — hung off `Booking`).
- Timezone-aware slot display (slots are stored/rendered in UTC via `Date`; add per-user timezone handling
  before real scheduling use).
- Email notifications (booking confirmations, payment receipts, reminders).
