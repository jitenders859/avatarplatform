# Remaining work

Everything below was left out of the first two build passes (README's old "What's intentionally not
built yet" section). This was the punch list for closing those gaps — all shipped now, verified end to
end against a local Postgres (signup → verify → forgot/reset password, book → reschedule → sweep to
COMPLETED → review → rating recompute, admin promotion + role gate, cron auth). Kept as a record of what
was built and the assumption/simplification each one landed on.

- [x] **Password reset.** `POST /api/auth/forgot-password` (always 200, doesn't leak whether an email
  exists) + `POST /api/auth/reset-password`, token-based, 1-hour expiry, delivered by email.
  `/forgot-password` and `/reset-password` pages.
- [x] **Email verification.** A verification link goes out on signup (`GET /api/auth/verify-email`
  redirects either way) plus a resend action from the dashboard. Soft verification, as planned — it's a
  trust signal (shown as a banner on `/dashboard` when unverified), not a gate; nothing else checks it.
- [x] **Transactional email.** `src/lib/mailer.ts` (nodemailer, no-ops with a `console.warn` when SMTP
  isn't configured — same pattern as the sibling `avatarplatform` app) backs booking confirmation, a
  reminder shortly before a session starts, and the password-reset/verification emails.
  `GET /api/cron/reminders` (bearer-secret protected) sends due reminders and sweeps completed bookings;
  meant to be hit by an external scheduler — see `vercel.json`'s `crons` entry (Vercel sends
  `Authorization: Bearer $CRON_SECRET` automatically when that env var is set on the project).
- [x] **Booking lifecycle: auto-complete past sessions.** `completeExpiredBookings()` sweeps `CONFIRMED`
  bookings whose `endAt` has passed to `COMPLETED`. Runs opportunistically on every `GET /api/bookings`
  (so it's fresh the moment someone looks) and again on the reminders cron as a backstop for bookings
  nobody happens to read.
- [x] **Instructor ratings & reviews.** `Review` model, one per booking, student-authored, only accepted
  once `COMPLETED` (`POST /api/bookings/:id/review`). Recomputes `Instructor.ratingAvg`/`ratingCount` in
  the same transaction as the insert. Displayed on the instructor's public profile and reviewable from the
  student dashboard.
- [x] **Booking rescheduling.** `POST /api/bookings/:id/reschedule` — student-only (the instructor's own
  remedy for "I can't make it" is still cancellation, which refunds), same duration and price, revalidated
  against the instructor's availability under the same advisory lock a fresh booking uses, moves the Daily
  room's join window (`updateSessionRoomWindow`) instead of minting a new room. UI lives on `/dashboard`.
- [x] **Instructor profile editing.** `/instructor-dashboard` now shows an edit form (pre-filled via
  `GET /api/instructors/:id`) for an existing instructor, reusing the same `POST /api/instructors` upsert
  the signup form uses, plus a "use my current browser timezone" action.
- [x] **Admin visibility.** `/admin` (role-gated, 404s for anyone else) with headline stats — users,
  instructors, active subscriptions, bookings by status, gross revenue, platform commission — and recent
  users/bookings tables. `npm run admin:promote -- <email>` bootstraps the first admin; there's still no
  self-serve path to becoming one, by design.

## Also fixed along the way

- **Cancel had no UI.** `POST /api/bookings/:id/cancel` existed from the first pass but nothing ever
  called it — added Cancel buttons to both the student and instructor booking tables.

## Second pass: gaps found by audit, not by spec

After the punch list above shipped, a targeted code audit (cross-referencing every API route against
every page, and every schema field against where it's read/written) turned up real, working-but-broken
issues that hadn't been on anyone's list. All fixed and verified the same way as everything else here:

- [x] **`?next=` redirects were ignored.** Five-plus call sites across the app build a
  `/login?next=/wherever` URL for a bounced-out user (booking flow, dashboards, pricing), but login and
  signup both hardcoded their post-auth destination instead of reading it. Fixed in both pages; the
  "sign up"/"log in" cross-links between them now carry `next` along too.
- [x] **Stripe/Connect redirect params were written but never read.** `success_url`/`cancel_url` on both
  Checkout flows, and the Connect account-link's `return_url`/`refresh_url`, all encode outcome via query
  string — no destination page displayed any of it (only `?verified=1` was wired up). Added banners on
  `/dashboard` (`booking=success`, `checkout=success`), `/pricing` (`checkout=canceled`),
  `/instructors/:id` (`booking=canceled`), and `/instructor-dashboard` (`connect=return`/`refresh`).
- [x] **`Subscription.cancelAtPeriodEnd` was write-only.** The webhook persisted it; nothing read it back,
  so a student who canceled via the billing portal still saw a plain "ACTIVE" with no hint it wouldn't
  renew. Now returned from `/api/auth/me` and shown on `/dashboard` ("Renews on…" / "Cancels on…").
- [x] **`User.countryId` was dead.** The signup API accepted `countryCode` but the signup page never
  collected it. Added a geo-prefilled (reusing `/api/geo`, same as onboarding) country select to signup.
- [x] **`GET /api/instructors/:id/reviews` had no caller.** The public profile page fetched reviews
  directly via Prisma instead. Rather than delete the route, gave it a real job: a new "Reviews you've
  received" section on `/instructor-dashboard`, so instructors can finally see their own reviews.
- [x] **`BookingStatus.NO_SHOW` was displayed but never set.** The admin panel had a stat tile for it that
  could only ever read zero. Added `POST /api/bookings/:id/no-show` (instructor-only, only after the
  session's start time has passed; doesn't touch price or payout — it's a record, not a refund trigger)
  and a "Mark no-show" button on `/instructor-dashboard`. Only the instructor can report a no-show; a
  student-side "the instructor didn't show" flow would need dispute handling and isn't built.
- [x] **Instructor `currency` was silently reset on every profile edit.** The edit form never sent it, so
  the API's `"usd"` zod default clobbered any non-default currency on save. The edit form now round-trips
  the instructor's actual currency instead of omitting the field.

## Third pass: correctness under concurrency and money edge cases

A third audit deliberately looked for a different class of bug than the first two (dead code, unwired
fields) — races, webhook idempotency, and business-rule bypasses. This one turned up actual money/data
integrity bugs, not just missing UI:

- [x] **Critical — the Stripe webhook could resurrect a canceled booking into a double-booked slot.**
  `checkout.session.completed` unconditionally set a booking to `CONFIRMED` on whatever `bookingId` its
  metadata pointed to, with no check that the booking hadn't since been canceled. Scenario: student opens
  Checkout, cancels the booking before paying (a canceled booking drops out of the busy-check, so its
  window is free again), a second student books that now-free window, then the first student's stale
  Checkout tab completes payment anyway — the webhook would flip the first (canceled) booking back to
  `CONFIRMED`, handing out two confirmed bookings for an overlapping window. Fixed: the confirmation is now
  a conditional `updateMany` (`WHERE status = 'PENDING_PAYMENT'`) — Postgres serializes concurrent updates
  to the same row, so this is race-safe without needing the advisory lock other booking writes use. A
  payment that lands on a booking that's no longer `PENDING_PAYMENT` gets auto-refunded instead of
  confirmed, and flagged (see `paymentIssueAt` below). Verified live: manually replayed exactly this
  sequence (create → cancel → signed webhook for the canceled booking) and confirmed the booking stayed
  `CANCELED`, not resurrected.
- [x] **High — cancel and reschedule had no locking, so they could race each other.** `cancel` read a
  booking's status once, then wrote `CANCELED` after an unbounded-latency Stripe refund call, with no
  guard that the status hadn't changed in between (e.g. a concurrent reschedule). `reschedule` checked
  status before opening its transaction, not inside it. Both now take the same per-instructor advisory
  lock booking creation uses, and both write via a conditional `updateMany` that only succeeds if the
  booking is still in the expected status — a losing racer gets a clean 409 instead of silently
  clobbering the winner's write. Verified live: a second cancel on an already-canceled booking now 409s
  with "Booking is already canceled" instead of silently no-oping.
- [x] **Medium — free-trial eligibility could be gamed by cancel-then-rebook.** Eligibility was computed
  from `CONFIRMED`/`COMPLETED` bookings only, so canceling a free session (always created `CONFIRMED`)
  made a student "first-time" again with that instructor — repeatable indefinitely, holding and releasing
  the instructor's calendar each time without ever paying. `hasUsedFreeTrial` (renamed from
  `hasPriorBooking`) now also counts any booking that was ever `isFreeSession: true`, regardless of its
  current status — a canceled *paid* booking still doesn't burn eligibility, since nothing free was ever
  given out. The check itself moved inside the same advisory-locked transaction as the booking write, so
  two concurrent requests from the same student can't both win the free trial either. Verified live: a
  student whose only prior booking with an instructor was free-and-then-marked-`NO_SHOW` was correctly
  charged (not given a second free session) on their next booking.
- [x] **Medium — no reaction to out-of-band refunds or disputes.** A refund issued from the Stripe
  dashboard, or a `charge.dispute.created` event, produced no app-side effect — the booking stayed
  `CONFIRMED` with a joinable video room even though the money had left the platform's control. Added
  handlers for both: they cancel the booking and set the `paymentIssueAt`/`paymentIssueNote` fields below.
- [x] **Medium — unbounded chat cost/context growth, no send-rate limit.** The full message history was
  replayed to Claude on every turn with no cap, and nothing throttled how fast a client could call the
  send endpoint. Added `MAX_CHAT_HISTORY_MESSAGES` (only the most recent N are replayed — the full
  transcript is still stored and shown to the student) and a simple per-user `CHAT_RATE_LIMIT_PER_MINUTE`
  throttle, counted across all of a student's sessions. Verified live (429 on the 21st message within a
  minute at the default limit of 20).
- [x] **Low — failed refunds were swallowed.** A failed `refunds.create` was only `console.error`'d; the
  booking still ended up `CANCELED` with no record anyone needed to look at it. Added `Booking.paymentIssueAt`
  / `paymentIssueNote` (set on a failed cancellation refund, an auto-refunded orphaned payment, or a
  dispute) and a "Payment issues" table + stat tile on `/admin` so these don't go unnoticed.

## Explicitly out of scope (not on this list)

- **Usage-metered billing** (charging for actual call attendance instead of booked duration) — a deliberate
  product decision from the original build, not an oversight; see the main README's assumptions section.
- **Automated tests** for this project — real, but a different kind of gap than the product functionality
  above; not covered here.
