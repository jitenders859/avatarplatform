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
4. **Instructors set recurring weekly availability, not one-off slots.** An instructor picks the hours
   they're generally free each day of the week (`InstructorAvailability`, in their own timezone —
   `/instructor-dashboard`). Students see that expanded into an actual calendar of open windows
   (`src/lib/availability.ts`) and can book any start time and duration (30-minute steps, `MIN_SESSION_MINUTES`
   to `MAX_SESSION_MINUTES`, default 30–180) that fits inside one — so billing follows exactly how much time
   they book, "1 hour" or "90 minutes" or anything else on the step.
5. **Free first session, then paid, by the minute.** A student's first-ever booking with a given instructor is
   free up to `FREE_INSTRUCTOR_SESSION_MINUTES` (default 30); only the minutes beyond that (or the whole
   session, on a repeat booking) are billed — instructor's hourly rate, prorated to the booked duration, *plus*
   a platform commission (`PLATFORM_COMMISSION_BPS`, default 15%) that the student pays on top. Payment is a
   single Stripe Checkout charge split via **Stripe Connect**: the platform's cut is collected as an
   `application_fee_amount` and the rest transfers straight to the instructor's connected account. See
   `src/lib/pricing.ts` (`splitInstructorRate`) and `src/app/api/bookings/route.ts`.
6. **Every confirmed booking gets a real video call.** `src/lib/video.ts` creates a private, time-boxed
   Daily.co room for each `CONFIRMED` booking (only joinable from shortly before it starts to shortly after it
   ends — enforced by Daily itself, not just the UI). `/session/:bookingId` mints a fresh per-participant join
   token and embeds the call.
7. **Accounts are verified, recoverable, and reviewed.** Signup sends a verification email (soft — it's a
   trust signal, nothing is gated on it); forgot/reset password is token-based. Every booking confirmation
   and pre-session reminder goes out by email (`src/lib/mailer.ts`, `src/lib/notifications.ts`); a booking
   auto-completes once its session is over, at which point the student can rate the instructor
   (`Review`, recomputes `Instructor.ratingAvg`). Students can reschedule or cancel a booking themselves
   from `/dashboard`. `/admin` (role-gated) gives a platform-wide view — users, revenue, commission, recent
   bookings.

## Stack

- **Next.js 14** (App Router, TypeScript) — full-stack: pages + API routes in one app.
- **PostgreSQL + Prisma** — see `prisma/schema.prisma` for the full data model (countries, license types,
  chatbots, chat sessions/messages, subscriptions, instructors, recurring availability, bookings).
- **Anthropic Claude** (`@anthropic-ai/sdk`) — the chatbot's brain; system prompt built per country/license
  in `prisma/seed.ts`, called from `src/lib/claude.ts`.
- **Stripe** — subscriptions for the chatbot paywall (`src/app/api/subscriptions/*`,
  `src/app/api/webhooks/stripe`) and **Stripe Connect Express** for instructor payouts + commission
  (`src/app/api/instructors/connect/*`, `src/app/api/webhooks/stripe-connect`, `src/app/api/bookings/*`).
- **Daily.co** — video calls for confirmed bookings (`src/lib/video.ts`); optional (booking/payment still
  work without an API key, sessions just won't get a room).
- **nodemailer / SMTP** — verification, password reset, booking confirmation, and reminder emails
  (`src/lib/mailer.ts`); optional (every send site no-ops with a `console.warn` without it configured).
- Hand-rolled JWT cookie auth (`src/lib/auth.ts`) — no third-party auth provider, kept intentionally simple.
- No date library — `src/lib/timezone.ts` does DST-safe local↔UTC conversion with just `Intl`.

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

### Video (Daily.co)

Grab an API key from [dashboard.daily.co/developers](https://dashboard.daily.co/developers) and set
`DAILY_API_KEY`. Nothing else to configure — rooms are created on the fly per booking. Without a key, booking
and payment still work end to end; confirmed sessions just won't have a room (`/session/:bookingId` will say
so) until it's set.

### Email + the reminders cron

Set `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` for real email delivery — without them, every send
just logs a warning. Separately, `GET /api/cron/reminders` needs to be hit on a schedule by something outside
the app (there's no in-process job queue) — it sends "starting soon" reminder emails and sweeps finished
bookings to `COMPLETED`. `vercel.json` already wires this up for Vercel (every 5 minutes); on Vercel, set the
`CRON_SECRET` env var and Vercel sends it automatically as the `Authorization: Bearer` header. Deploying
elsewhere: point any scheduler (cron, GitHub Actions, etc.) at that URL with the same header.

### Bootstrapping an admin

There's no self-serve way to become an admin. After someone has an account:

```bash
npm run admin:promote -- someone@example.com
```

They'll see an "Admin" link in the nav and can load `/admin` for platform-wide stats.

## Project layout

```
prisma/schema.prisma        Data model
prisma/seed.ts               Countries, license types, chatbot system prompts
src/lib/                     Server-side building blocks:
                                db, auth — Postgres/Prisma client, JWT session auth, token generation
                                claude — chatbot replies
                                stripe, pricing — Stripe client, rate/commission math
                                timezone, availability — recurring-availability calendar math
                                video — Daily.co rooms + join tokens
                                mailer — SMTP send (verification, reset, booking emails)
                                notifications — ties bookings to mailer + the completion sweep
                                instructors — matching/eligibility helpers
src/app/api/                 Route Handlers — the whole backend (auth, bookings, instructors, cron, webhooks)
src/app/                     Pages (App Router) — including /admin, /dashboard, /instructor-dashboard
src/components/              Small client components shared across pages (Calendar, InstructorBooking, Nav)
scripts/promote-admin.ts     One-off script to bootstrap the first admin account
docs/REMAINING_WORK.md       Record of a completed gap-closing pass — see it for what shipped and when
```

## Notable product assumptions baked into the code

These were judgment calls made to ship a coherent v1 — revisit them as the real product spec firms up:

- The free chatbot message limit is **per platform**, not per chatbot — a student who exhausts it on the US
  CPL bot is also paywalled on the Canada PPL bot (`ChatSession.freeMessagesUsed` is tracked per session, the
  gate check itself just isn't relaxed per-chatbot; adjust in
  `src/app/api/chat/sessions/[id]/messages/route.ts` if you want per-chatbot trials instead).
- "First session free" is scoped **per instructor**, not once platform-wide — a student gets a free trial
  session with every new instructor they try (`src/lib/instructors.ts#hasPriorBooking`).
- If a free trial booking is longer than `FREE_INSTRUCTOR_SESSION_MINUTES`, only the extra time is billed (see
  `POST /api/bookings`) rather than the whole session becoming free or paid.
- A `User` can hold both a student and an instructor profile at once (the `Instructor` model wraps a `User`
  rather than replacing it); `User.role` flips to `INSTRUCTOR` the first time someone creates an instructor
  profile, but that's advisory only — it doesn't gate any student-side feature.
- A session can't be booked across local midnight in the instructor's timezone (`checkWindowAvailable` in
  `src/lib/availability.ts` rejects it outright) — an instructor who's free 10pm–2am needs that split into two
  availability rows (10pm–midnight, midnight–2am) rather than one that wraps.
- Booking-window conflicts are prevented with a Postgres advisory lock scoped to the instructor
  (`pg_advisory_xact_lock`, inside the booking transaction) rather than a DB-level exclusion constraint —
  simpler to ship, and sufficient unless booking volume per instructor gets very high.
- The estimated price shown before booking (`InstructorBooking.tsx`) is rate × duration only, no commission —
  it's explicitly labeled "+ platform fee"; the exact total is whatever Stripe Checkout shows before payment.
- Email verification is a trust signal only — nothing in the app is gated on `User.emailVerified`.
- Only the student can reschedule a booking; the instructor's remedy for "I can't make it" is cancellation
  (which refunds a paid session), not a reschedule.
- Rescheduling keeps the original duration and price — you're moving the clock, not renegotiating the deal.
- The `/admin` panel is read-only (stats + recent activity) — no user management, refund, or dispute actions
  from it yet.

## What's intentionally not built yet

- **Usage-metered billing** — charging for actual call attendance instead of booked duration. A deliberate
  product decision, not an oversight: see "Notable product assumptions" above (price is set at booking time).
- **Automated tests.** This project doesn't have a test suite yet; everything so far has been verified by
  hand against a local Postgres each time something shipped (see `docs/REMAINING_WORK.md` for what was
  checked).

`docs/REMAINING_WORK.md` has the fuller history of what was deliberately deferred in earlier passes and
then closed out — worth a read before assuming something's missing.
