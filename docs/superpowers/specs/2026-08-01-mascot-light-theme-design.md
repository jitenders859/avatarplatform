# Mascot.bot-style light theme

**Files:** `public/css/app.css`, `public/css/docs.css`, `public/css/embed.css`, `public/js/api.js`, `public/js/theme.js` (new), `public/index.html`, `public/pricing.html`, `public/contact.html`, `public/terms.html`, `public/docs/*.html` (8 files), `public/dashboard.html`, `public/account.html`, `public/analytics.html`, `public/billing.html`, `public/characters.html`, `public/project.html`, `public/login.html`, `public/signup.html`, `public/forgot-password.html`, `public/reset-password.html`, `public/embed.html`, `backend/routes/projects.js`, `backend/routes/embed.js`, `supabase/schema.sql`
**Status:** Approved, ready for implementation plan

## Context

The app currently ships one hardcoded dark theme (`public/css/app.css` tokens under `:root`, no light option). The user wants a light theme modeled visually on the mascot.bot website redesign (`/Users/uhkjjkhjh/Downloads/Mascot.bot website redesign/*.dc.html`) — a warm-cream, bold-purple, rounded, slightly playful look distinct from today's dark SaaS aesthetic — added as a **toggle**, not a wholesale replacement, and applied to all three of the app's stylesheets: the main app (`app.css`), the docs site (`docs.css`), and the embeddable chat widget (`embed.css`).

Reference palette extracted from the mascot.bot comps (e.g. `Dashboard.dc.html`): background `#FFF7EC`, cards `#fff` with `rgba(36,27,47,0.06-0.12)` borders, primary purple `#6C4FF0` (hover `#5539D6`, pressed-shadow `#4227A8`), text `#241B2F` / muted `#6B6178`, soft accent badge bg `#F3ECFF`, success badge `#E1F6EC`/`#1F9E63`, large radii (22-24px cards, 12-14px controls, 999px pills), chunky `0 4px 0 <darker-accent>` "pressed" button shadows, headings in `'Baloo 2'` (700/800), body in `'Plus Jakarta Sans'`.

Decisions made during brainstorming (recorded here since they resolve real ambiguity):
- **Toggle, not replacement** — dark mode stays fully intact; light becomes the new default for anyone without a saved preference.
- **Palette**: use mascot.bot's own purple (`#6C4FF0`) for the light theme's `--accent`, not the app's current `#7c6af5` — the user picked the "warm clone" direction (exact mascot.bot palette) over a hybrid that kept the current brand purple.
- **Fonts**: Baloo 2 + Plus Jakarta Sans are a theme-independent brand change — both light and dark modes use them. This is not part of the token swap; it's a straight global font-stack change across all three CSS files.
- **Embed widget**: gets a genuinely new per-project `widgetTheme` setting (light/dark), independent of the app's own toggle — the widget lives on customers' external sites and doesn't share the app-user's theme preference. All existing and new projects default to `widgetTheme = 'light'` (explicit choice: flip every live embed to the new look immediately, no dark grandfathering).

Out of scope: any layout/structural redesign (spacing, grid, component composition unchanged — only color, radius, shadow, and font tokens change); redesigning the dark palette's actual values (it's relocated, not touched); an end-visitor-facing toggle on the embed widget itself (theme is fixed per project by its owner, same as `themeColor` today); automated visual regression testing.

---

## Part 1 — Token system (`app.css`, `docs.css`, `embed.css`)

Light tokens become the new `:root` default; today's dark values move under `:root[data-theme="dark"]` verbatim (a relocation, not a redesign — dark mode must look pixel-identical to today when active).

`app.css` / `docs.css` share one token set (`docs.css` already reads `var(--bg)`, `var(--text)`, etc. from `app.css`, plus a few hardcoded dark colors — e.g. `#111118`, `rgba(255,255,255,0.06)` in `.docs-sidebar` — that get converted to `var(--bg-2)` / `var(--border)` equivalents so the sidebar actually responds to the toggle instead of staying dark always).

```css
:root {
  --accent: #6C4FF0;
  --accent-2: #8A72FF;
  --accent-glow: rgba(108,79,240,0.25);
  --accent-soft: #F3ECFF;        /* new — badge/pill backgrounds */

  --bg: #FFF7EC;
  --bg-2: #FFFFFF;                /* cards */
  --bg-3: #FBF6EE;                /* inputs, hover states */
  --bg-4: #F3ECFF;                /* accent-tinted hover */
  --border: rgba(36,27,47,0.08);
  --border-strong: rgba(36,27,47,0.14);

  --text: #241B2F;
  --text-2: #6B6178;
  --text-dim: #9089A0;

  --success: #1F9E63;  --success-bg: #E1F6EC;
  --warn:    #B45309;  --warn-bg:    #FEF3C7;
  --danger:  #DC2626;  --danger-bg:  #FEE2E2;

  --radius: 14px;
  --radius-lg: 22px;
  --shadow: 0 1px 2px rgba(36,27,47,.06), 0 8px 24px rgba(36,27,47,.08);
  --shadow-lg: 0 24px 60px rgba(36,27,47,.18), 0 4px 16px rgba(36,27,47,.12);

  --btn-primary-bg: var(--accent);                 /* solid, mascot-style */
  --btn-shadow: 0 4px 0 #4227A8;                    /* "pressed" look */
  --mark-shadow: 0 2px 0 #5539D6;                   /* brand-mark / user-avatar */

  --font-heading: 'Baloo 2', sans-serif;
  --font-body: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

:root[data-theme="dark"] {
  --accent: #7c6af5;
  --accent-2: #a78bfa;
  --accent-glow: rgba(124,106,245,0.25);
  --accent-soft: rgba(124,106,245,.12);

  --bg: #0a0b13;
  --bg-2: #11131c;
  --bg-3: #181a25;
  --bg-4: #20232f;
  --border: rgba(255,255,255,0.08);
  --border-strong: rgba(255,255,255,0.14);

  --text: #ecedf3;
  --text-2: #b6bbcc;
  --text-dim: #7a8090;

  --success: #86efac; --success-bg: rgba(34,197,94,.1);
  --warn:    #fcd34d; --warn-bg:    rgba(245,158,11,.1);
  --danger:  #fca5a5; --danger-bg:  rgba(239,68,68,.1);

  --radius: 12px;
  --radius-lg: 16px;
  --shadow: 0 1px 2px rgba(0,0,0,.2), 0 8px 24px rgba(0,0,0,.25);
  --shadow-lg: 0 24px 60px rgba(0,0,0,.45), 0 4px 16px rgba(0,0,0,.35);

  --btn-primary-bg: linear-gradient(135deg, var(--accent), var(--accent-2));
  --btn-shadow: 0 4px 16px var(--accent-glow);
  --mark-shadow: 0 4px 12px var(--accent-glow);
}

/* font-family stays outside the theme block — applies to both */
html, body { font-family: var(--font-body); }
h1, h2, h3, .page-title, .card-title, .brand, .hero-title { font-family: var(--font-heading); font-weight: 700; }
```

Component rules updated to consume the new tokens instead of hardcoded values:
- `.btn-primary`: `background: var(--btn-primary-bg); box-shadow: var(--btn-shadow);`
- `.brand-mark`, `.user-avatar`: `background: var(--btn-primary-bg); box-shadow: var(--mark-shadow);`
- `.pill-success` / `.pill-warn` / `.pill-danger` / `.pill-info`: swap hardcoded `rgba(...)` pairs for `var(--success)`/`var(--success-bg)` etc.
- Google Fonts `<link>` (`Baloo+2:wght@500;600;700;800` + `Plus+Jakarta+Sans:wght@400;500;600;700;800`) added once per HTML page's `<head>`, alongside the existing `preconnect` pattern mascot.bot's comps use.

`embed.css` gets its own light token block (background stays `transparent` at the `html,body` level as today — only the panel/bubble surfaces pick up the new light colors) plus a matching `[data-theme="dark"]` override holding today's values. It is **not** wired to the app's `apTheme` localStorage toggle — see Part 3.

## Part 2 — Toggle mechanism (app + docs, not embed)

- `data-theme="light"|"dark"` attribute on `<html>`. Light is the default whenever `localStorage['apTheme']` is unset.
- Anti-flash inline script, first thing in every app/docs page's `<head>`, before any stylesheet `<link>`:
  ```html
  <script>document.documentElement.dataset.theme = localStorage.getItem('apTheme') === 'dark' ? 'dark' : 'light';</script>
  ```
- `public/js/theme.js` (new, shared by all pages that show a toggle):
  ```js
  const Theme = {
    get: () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    set(t) { document.documentElement.dataset.theme = t; localStorage.setItem('apTheme', t); },
    toggle() { Theme.set(Theme.get() === 'dark' ? 'light' : 'dark'); },
  };
  ```
- **Injection points:**
  - `renderTopNav()` in `public/js/api.js` — the single shared nav renderer used by `dashboard`, `account`, `analytics`, `billing`, `characters`, and `project` — gets one sun/moon icon button added next to `#user-menu`, wired to `Theme.toggle()` and updating its own icon on click.
  - Static marketing/doc pages with their own hardcoded nav markup (`index.html`, `pricing.html`, `contact.html`, `terms.html`, and each `public/docs/*.html`'s `.docs-brand` row) each get the same button markup added directly, plus a `<script src="/js/theme.js">` include.
  - `login.html`, `signup.html`, `forgot-password.html`, `reset-password.html` have no nav today and get none added — they just carry the anti-flash script so they render in the correct theme, with no visible toggle control (consistent with today's minimal auth-screen chrome).

## Part 3 — Embed widget: per-project `widgetTheme`

Mirrors the existing `themeColor` pattern exactly (same files, same shape of change), independent of the app's `apTheme` toggle:

**`supabase/schema.sql`** — add to the `projects` table definition:
```sql
widget_theme  TEXT  DEFAULT 'light',
```
Also append (idempotent, safe against the already-deployed table):
```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS widget_theme TEXT DEFAULT 'light';
```
Run against production only with explicit user confirmation, same as prior schema changes in this repo (e.g. the full-screen-mode fields).

**`backend/routes/projects.js`** — add `'widgetTheme'` to the `PATCH /:id` allowed-fields list; add `widgetTheme: 'light'` to project-creation defaults alongside `themeColor`.

**`backend/routes/embed.js`** `GET /:publicId/config` — expose `widgetTheme: project.widgetTheme || 'light'` alongside the other widget settings.

**`public/embed.html`** `boot()` — after resolving `themeColor`, set:
```js
document.documentElement.dataset.theme = config.project.widgetTheme || 'light';
```
No anti-flash handling needed — the existing `.boot-overlay` already covers the widget until `boot()` finishes, same as it does for every other config-dependent value today.

**`public/project.html`** — new "Widget theme" `<select id="f-widget-theme">` (Light / Dark) in the same settings block as "Theme color", following the exact load (`p.widgetTheme || 'light'`) / save (included in the `updateProject` patch) wiring already used for `f-theme`.

## Error handling / edge cases

- A project created before this change has `widget_theme = NULL` until the `ALTER TABLE` backfill runs (column default only applies to new rows) — `routes/embed.js`'s `project.widgetTheme || 'light'` fallback covers this regardless, so the widget is never left without a valid theme even mid-rollout.
- A user with a saved `apTheme` visits a static page that hasn't been updated with the toggle yet (rollout ordering): the anti-flash script still applies their saved preference correctly since it only depends on `localStorage`, not on the toggle button existing.
- `embed.css`'s dark override must not regress today's live widgets before the schema/backend change ships — sequencing note for the implementation plan: ship `embed.css` + `embed.html` theme wiring together with the backend default, not the CSS alone, so there's no window where `widgetTheme` is undefined and the widget falls back to unstyled tokens.

## Testing

No automated visual regression harness (consistent with how styling-only changes are verified elsewhere in this repo) — manual verification:

1. Load each app page (`dashboard`, `account`, `analytics`, `billing`, `characters`, `project`, `index`, `pricing`, `contact`, `terms`, each `docs/*`) fresh (no `apTheme` set) — confirm light theme renders by default, no flash of the old dark styling.
2. Click the toggle on a page using `renderTopNav()` — confirm theme flips instantly, persists across a reload, and persists across navigation to a different page (shared `localStorage` key).
3. Click the toggle on a static marketing page — same check.
4. Switch to dark on a page, reload — confirm dark renders with **zero visual difference** from the current production dark theme (this is the regression check: dark mode must be unchanged).
5. Check contrast on light theme: body text (`#241B2F`) on cream (`#FFF7EC`) and on white cards, muted text (`#6B6178`) on both backgrounds, primary button text (white) on `#6C4FF0`.
6. `login`/`signup`/`forgot-password`/`reset-password` — confirm they pick up light/dark correctly via the anti-flash script despite having no visible toggle.
7. In `project.html`, set "Widget theme" to Dark, save, open the Preview tab and a real embedded instance — confirm the widget renders dark while the surrounding app page (if light) does not change.
8. Set "Widget theme" back to Light (or leave default on a fresh project) — confirm it matches the mascot.bot warm-clone palette from Part 1.
9. Confirm an *existing* project (created before this change, once the `ALTER TABLE` backfill has run) shows `widgetTheme = 'light'` by default, matching the "flip everyone to light immediately" decision.
