# AvatarPlatform Live Handoff (Chrome extension)

Thin desktop notifier for the [human handoff](../docs/superpowers/specs/2026-08-28-human-handoff-design.md)
feature. It does not reimplement the takeover UI — it watches the same
`/ws/dashboard/:projectId` WebSocket the dashboard's Live Chat tab uses, fires
a native notification when a new visitor is waiting, shows a badge count on
the toolbar icon, and clicking a notification opens the dashboard straight
into that conversation.

No build step — it's plain JS/HTML, Manifest V3.

## Load it (development)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Click the toolbar icon, enter your AvatarPlatform server URL (e.g.
   `http://localhost:8080` or your production domain), and log in with your
   normal account email/password.

Only projects on the **business plan** get live notifications — the
extension attempts every project on the account and the server itself
enforces the plan gate on the WebSocket upgrade, so an ineligible project
just never shows as connected (grey dot in the popup).

## How it works

- `background.js` — the whole brain. Logs in via `POST /api/auth/login`,
  lists projects via `GET /api/projects`, and opens one
  `/ws/dashboard/:projectId` socket per project. On a `queue_update` frame
  with a session id it hasn't seen before, it fires a
  `chrome.notifications` alert and updates the toolbar badge with the total
  pending count across all connected projects.
- `popup.html`/`popup.js` — login form when signed out; otherwise a small
  per-project connection/pending list plus "Open dashboard" and "Log out".
- A `chrome.alarms` sweep every 5 minutes reconnects anything that dropped —
  covers the service worker being killed by Chrome, a network blip, or the
  machine waking from sleep.

Auth token and server URL are stored in `chrome.storage.local`, scoped to
the extension.
