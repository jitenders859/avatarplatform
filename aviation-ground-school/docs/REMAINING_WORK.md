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

## Explicitly out of scope (not on this list)

- **Usage-metered billing** (charging for actual call attendance instead of booked duration) — a deliberate
  product decision from the original build, not an oversight; see the main README's assumptions section.
- **Automated tests** for this project — real, but a different kind of gap than the product functionality
  above; not covered here.
