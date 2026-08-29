# Competitive Feature Gap — Implementation Plan

Generated 2026-08-29. Scope: cross-platform feature comparison against embeddable AI avatar/chat
platforms, translated into a phased plan against this codebase's existing patterns
(`backend/routes/*`, `backend/services/*`, `public/js/*`, `supabase/schema.sql`).

## Method

Researched four competitor categories and pulled the features that recur across 3+ products
(a strong "table stakes" signal) or that are the explicit headline differentiator of their
category:

1. **AI video/interactive avatar platforms** — HeyGen, D-ID, Synthesia, Tavus, Delphi.ai, Soul
   Machines, Simli, Yepic AI
2. **AI character/companion + embeddable widget builders** — Character.AI, Convai, Inworld AI,
   Charisma.ai
3. **General embeddable RAG chatbot builders** — Chatbase, Voiceflow, Intercom Fin, Crisp,
   Landbot, Tidio, Botpress
4. **Voice AI agent platforms** — ElevenLabs Conversational AI, Vapi, Retell AI

Full findings are below the plan. This platform's current strengths (Rive lip-synced avatar,
Gemini Live voice, pgvector RAG, per-project widget theming, webhooks, 4-tier billing, admin
panel) are not re-listed as gaps — see `README.md` / `project.md` for what already exists.

---

## Priority ranking (impact vs. effort, reusing existing patterns where possible)

- **Phase 1** (highest impact, builds directly on existing tables/routes): live agent handoff,
  richer analytics (CSAT + drop-off/funnel), sentiment tagging, "AI actions" (agentic
  function-calling beyond RAG Q&A).
- **Phase 2** (new integration surface, moderate effort): CRM/helpdesk integrations
  (Zapier-first, then native), white-labeling/custom domain, voice cloning.
- **Phase 3** (new billing/infra model, higher effort): usage-based/metered billing overlay,
  multi-channel deployment (WhatsApp first), SSO for enterprise tier.
- **Phase 4** (strategic decisions needed before building — see "Needs a decision"): visual
  conversation-flow builder, BYO-model flexibility, expanded multilingual voice, photorealistic
  video avatars.

---

## Phase 1: Support-quality features on existing infrastructure

### 1a. Live agent handoff (human takeover)
**Why it matters:** Cited across Chatbase, Intercom Fin, Crisp, Tidio, Landbot — the single most
common gap. Buyers evaluating any support-facing bot expect an escalation path when the AI can't
resolve something.
**Build on:** `sessions`/`messages` tables and the existing Gemini function-calling tool
framework (`backend/services/tools.js`) already give the model a way to signal state changes
mid-conversation — add a `request_human_handoff` tool the model can call when it's stuck or the
user asks for a person. Persist a `sessions.status` column (`bot` / `handoff_requested` /
`human`) and surface handoff-requested sessions in the dashboard (`project.html`'s sessions
view) with a lightweight reply-from-dashboard UI, reusing the existing `messages` log path
(`POST /embed/:id/log`) for owner replies. A full live-chat UI is a larger scope decision (see
below); start with "flag + owner can see + reply async," not real-time agent presence.
**Needs a decision:** real-time (WebSocket) human takeover vs. async (owner checks a queue and
replies, visitor polls). Async is far cheaper to build on top of the current architecture and
matches this platform's async-Q&A precedent (`POST /embed/:publicId/ask`).

### 1b. CSAT / drop-off analytics
**Why it matters:** Intercom's Fin AI CX Score and Chatbase's failure analytics are headline
paid features; this platform's `backend/routes/analytics.js` currently only aggregates
counts/charts, not conversation quality.
**Build on:** Extend `analytics.js`'s existing SQL-aggregate style. Two additions:
- A per-session thumbs-up/down prompt in the widget (`embed.html`), logged as a new
  `sessions.satisfaction` field, rolled up the same way existing daily charts are computed.
- A "drop-off" metric: sessions with only 1 message before abandonment, or where a RAG retrieval
  returned zero/low-score chunks (`RAG_MIN_SCORE` threshold already exists in
  `backend/services/vector.js` — log a `no_answer_found` flag on those messages and chart the
  rate per project).

### 1c. Sentiment tagging
**Why it matters:** Tidio and Crisp both surface conversation sentiment/summarization as a
premium tier; low-effort to add given RAG infra already calls Gemini per message.
**Build on:** A cheap batch job (reuse the Inngest background-job pattern from
`backend/inngest/functions.js`) that periodically tags recent `sessions` with a sentiment label
via a single Gemini call over the transcript, stored as `sessions.sentiment`. Surface as a filter
in the existing sessions list UI. Do not add a synchronous per-message sentiment call — it would
add latency to every live turn for no user-facing benefit.

### 1d. "AI actions" (agentic capabilities beyond RAG Q&A)
**Why it matters:** Chatbase, Botpress, and Voiceflow all let the bot *do* something (book an
appointment, check order status), not just answer from documents — this is table stakes for
"conversational assistant" positioning, and Gemini function-calling is already wired in.
**Build on:** `backend/services/tools.js` already declares `search_knowledge_base` as a
function-calling tool. Add an owner-configurable action framework: a new `project_actions` table
(name, trigger description, outbound webhook URL + payload template) that lets an owner define
a custom action (e.g. "check_order_status" → calls their API), registered as an additional Gemini
tool per project at session-setup time. This reuses the existing outbound-webhook signing
infrastructure (`backend/services/webhookDelivery.js`, HMAC pattern) rather than inventing a new
integration mechanism.

---

## Phase 2: Integrations & white-label

### 2a. CRM/helpdesk integrations (Zapier first)
**Why it matters:** Named across Chatbase (Zendesk/Freshdesk/HubSpot/Intercom), Botpress
(190+ integrations), Voiceflow/Landbot/Tidio (Zapier-centric). Building native connectors for
every CRM is high effort for uncertain payoff; a Zapier/Make "trigger" is the standard low-effort
entry point competitors use to claim broad integration breadth.
**Build on:** The existing signed-webhook mechanism (`webhookUrl` per project,
`backend/services/webhookDelivery.js`) already emits the `message` event Zapier's "Webhooks by
Zapier" trigger can consume — this is close to a documentation task (a `/docs` guide showing
Zapier catch-hook setup) plus maybe a `lead` event type alongside the existing `message` event,
rather than new backend work. Native HubSpot/Salesforce push (create-a-contact-on-lead-capture)
is a distinct, larger Phase-3-or-later item — flag, don't build yet.

### 2b. White-labeling / custom domain
**Why it matters:** Crisp (Plus tier), Landbot, and the avatar platforms all gate this as an
enterprise/business upsell — it's a recognized revenue lever the current 4-tier plan doesn't use.
**Build on:** `projects.showBranding` already exists as a boolean toggle (README: "show/hide
branding watermark") — this is "remove branding," not full white-label. Full white-label needs:
(1) a `projects.customDomain` field + reverse-proxy/CNAME verification for embed hosting, (2) a
`Business`+ plan gate in `backend/plans.js`. Custom domain is the higher-effort half (DNS
verification, TLS provisioning) — consider scoping v1 to "branding removal" (already close to
done) and treating custom domains as a separate, later decision.

### 2c. Voice cloning
**Why it matters:** Central to Inworld, ElevenLabs, and Synthesia's "Personal Avatar" tier —
this platform currently uses stock voices only (Gemini Live / ElevenLabs / OpenAI Realtime
presets per README).
**Build on:** The platform already supports ElevenLabs as a voice provider option per
`project.md`'s architecture notes — ElevenLabs' voice-cloning API can plug into that existing
integration point rather than requiring a new provider integration. Scope: an owner uploads a
voice sample → stored via the existing Supabase Storage pattern (`backend/services/storage.js`)
→ ElevenLabs clone API creates a voice ID → stored on `projects.voiceId`. Gate behind Pro/Business
plan (matches competitor packaging).

---

## Phase 3: Billing model & channel expansion

### 3a. Usage-based/metered billing overlay
**Why it matters:** HeyGen, Tavus, Vapi, Retell, and ElevenLabs all price per-minute/per-message
with overage rather than flat tiers — used both as a revenue lever and a low-friction trial
mechanism. The current 4-tier flat model (`backend/plans.js`) has no metered option.
**Build on:** `backend/services/usage.js` already tracks monthly message/embedding-char counters
per project — the counting infrastructure exists. Adding metered overage means: (1) a per-plan
`overageRate` field in `plans.js`, (2) Stripe metered billing (usage records API) instead of
flat subscription items, (3) a usage-alert threshold in the existing usage dashboard. This is a
Stripe integration change, not a new tracking system — moderate effort, contained mostly to
`backend/services/stripe.js` and `billing.js`.

### 3b. Multi-channel deployment (WhatsApp first)
**Why it matters:** Botpress, Voiceflow, and Intercom Fin all deploy one bot across
WhatsApp/Instagram/Slack from a single config — a strong, repeated pattern. Full multi-channel
parity is large; WhatsApp is the highest-value single addition (largest reach, well-documented
Business API).
**Build on:** The core RAG/answer logic already lives behind `POST /embed/:publicId/ask` as a
stateless text endpoint — a WhatsApp Business API webhook receiver is a new thin route
(`backend/routes/whatsapp.js`) that maps inbound WhatsApp messages to that same `ask` logic and
relays replies via the WhatsApp Cloud API, rather than duplicating RAG/session logic.

### 3c. SSO for enterprise tier
**Why it matters:** HeyGen and Tavus both gate SSO/SOC2/HIPAA behind their top tier — a
recognizable enterprise revenue lever this platform doesn't have (current auth is
email+password JWT only, per `backend/routes/auth.js`).
**Needs a decision:** Which SSO protocol/provider (SAML via WorkOS/Auth0, or OIDC only) — this
is a build-vs-buy call best made once there's an actual enterprise prospect asking, since it's
pure cost with no benefit to the self-serve tiers. Do not build speculatively.

---

## Phase 4: Needs a decision before building

These are the largest, most strategically-loaded items — each requires a product decision, not
just an estimate, before scoping:

1. **Visual conversation-flow builder** (Voiceflow/Botpress/Landbot's core differentiator). This
   platform is intentionally prompt+RAG driven, not flow-driven — adding a flowchart canvas is
   close to a second product, not an incremental feature. Decide whether "AI actions" (1d) covers
   enough of the underlying need (letting owners define structured behaviors) before considering
   a full visual builder.
2. **BYO-model/provider flexibility** (Vapi's positioning: swap LLM/STT/TTS, pay provider cost +
   platform fee). Conflicts with the current fixed Gemini-centric stack and pricing model
   (flat tiers assume known per-message cost). Would require reworking `backend/plans.js`'s cost
   assumptions.
3. **Expanded multilingual voice breadth** (Tavus 30+, Synthesia 120+, ElevenLabs/Inworld
   70-200+ languages vs. this platform's 5-language UI i18n). Note this platform's i18n
   (`public/js/i18n/*`) is *UI chrome* translation, separate from Gemini Live's own multilingual
   voice capability, which may already cover more languages than the UI does — worth auditing
   Gemini Live's supported languages before assuming this is a real gap.
4. **Photorealistic/video avatars** (HeyGen, D-ID, Tavus, Synthesia, Soul Machines, Simli — the
   entire category's core value prop). This platform's 2D Rive vector avatars are a deliberate
   lower-cost, lower-latency alternative, not an oversight. Chasing photorealism would mean
   competing head-on against companies built solely around that problem. Recommend explicitly
   **not** pursuing this — it's the most visible gap to a buyer doing a feature checklist, but
   closing it would abandon this platform's cost/latency advantage rather than extend it.

---

## Research findings (raw)

### Top features found across 3+ competitors, not yet in this platform

1. **Live agent handoff / human takeover** — Chatbase, Intercom Fin, Crisp, Tidio, Landbot.
2. **Native CRM/helpdesk integrations** (HubSpot, Salesforce, Zendesk, Freshdesk) — Chatbase,
   Botpress (190+ integrations), Voiceflow, Landbot, Tidio.
3. **Visual conversation-flow builder** — Voiceflow, Botpress, Landbot.
4. **Multi-channel deployment** (WhatsApp, Instagram, Slack, Messenger, phone) — Botpress,
   Voiceflow, Intercom Fin.
5. **Fine-grained analytics** (CSAT/CX score, drop-off funnels, resolution rate) — Intercom Fin
   (paid add-on), Chatbase, Tidio.
6. **Sentiment analysis** — Tidio (premium tier), Crisp.
7. **White-labeling / custom domain** — Crisp (Plus tier), Landbot, HeyGen/Synthesia (Business+).
8. **Voice cloning** — Inworld (instant + professional cloning), ElevenLabs, Synthesia
   ("Personal Avatar" tier).
9. **SSO / enterprise security tier** — HeyGen (Business, +$20/seat), Tavus (SOC2/HIPAA).
10. **Realistic/interactive video avatars** — HeyGen, D-ID, Tavus, Synthesia, Soul Machines,
    Simli — the category's headline product.
11. **Usage-based/metered pricing** — HeyGen ($0.05/sec), Tavus, Vapi, Retell, ElevenLabs
    (all $0.05-0.24/min).
12. **BYO-model/provider flexibility** — Vapi ("developer-first," swap LLM/STT/TTS providers).
13. **Agentic "AI actions"** (book appointments, check order status, not just Q&A) — Chatbase,
    Botpress, Voiceflow.
14. **Multilingual voice breadth as a marketed spec** — Tavus (30+), Synthesia (120+),
    ElevenLabs/Inworld (70-200+).

### Pricing/packaging patterns worth noting

- **Metered minutes/messages with overage** dominates avatar and voice categories rather than
  flat seat tiers.
- **Per-outcome billing** is emerging (Intercom Fin: $0.99/resolution, $9.99/lead qualification)
  as an alternative to subscriptions.
- **Enterprise gates**: SSO, white-labeling, custom/personal avatars, and compliance
  (SOC2/HIPAA) are consistently reserved for top/custom-priced tiers across nearly every
  competitor.
- **Free tiers are watermarked/capped-minute trials** (HeyGen 3 videos, Synthesia 10 min, D-ID
  Lite with watermark, Tavus 20 free min) — used as low-friction viral/trial mechanisms. This
  platform's Free tier (3 projects / 100 messages) is directionally similar but uncapped by time.

### Sources

[HeyGen pricing](https://www.arcade.software/post/heygen-pricing) ·
[D-ID pricing](https://www.g2.com/products/d-id/pricing) ·
[Tavus CVI](https://www.tavus.io/post/conversational-video-interface-cvi-bridge-between) ·
[Synthesia pricing](https://www.eesel.ai/blog/synthesia-pricing) ·
[Chatbase CRM integration](https://www.chatbase.co/blog/crm-chatbot) ·
[Voiceflow vs Botpress](https://quiq.com/blog/voiceflow-vs-botpress/) ·
[Intercom Fin pricing](https://coworker.ai/blog/intercom-fin-pricing) ·
[Vapi/Retell/ElevenLabs comparison](https://www.retellai.com/blog/retell-vs-bland-vs-vapi-vs-elevenlabs) ·
[Simli](https://aiagents.saastrac.com/ai-agent/simli/) ·
[Inworld voice cloning](https://inworld.ai/voice-cloning) ·
[Landbot review](https://www.tidio.com/blog/landbot-review/) ·
[Crisp alternatives](https://crisp.chat/en/alternatives/tidio/)
