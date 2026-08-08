# Graph Report - .  (2026-07-11)

## Corpus Check
- 76 files · ~75,505 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 978 nodes · 1455 edges · 72 communities (45 shown, 27 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 44 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]

## God Nodes (most connected - your core abstractions)
1. `LipsyncAvatar` - 35 edges
2. `m` - 23 edges
3. `CharacterBehaviorController` - 23 edges
4. `CharacterBehaviorController` - 22 edges
5. `HybridLipSyncController` - 17 edges
6. `Express App Assembly` - 14 edges
7. `LipsyncAvatar class` - 14 edges
8. `AudioClock` - 13 edges
9. `processFile` - 12 edges
10. `Marketing Landing Page` - 12 edges

## Surprising Connections (you probably didn't know these)
- `Documented /embed/:publicId/tts Proxy Route (unverified in code)` --conceptually_related_to--> `GET /:publicId/config Route`  [AMBIGUOUS]
  public/docs/elevenlabs-avatar.html → backend/routes/embed.js
- `project.md — Embed Widget section` --conceptually_related_to--> `embed-loader.js mount() iframe/FAB bootstrapper`  [AMBIGUOUS]
  project.md → public/js/embed-loader.js
- `React Native AvatarWidget (documented, package not found in repo)` --semantically_similar_to--> `AvatarWidget React component`  [INFERRED] [semantically similar]
  public/docs/react-native-sdk.html → public/sdk/react.js
- `Embed Widget Runtime Page` --calls--> `POST /:publicId/study Route`  [EXTRACTED]
  public/embed.html → backend/routes/embed.js
- `Embed Widget Runtime Page` --calls--> `POST /:publicId/quiz-attempt Route`  [EXTRACTED]
  public/embed.html → backend/routes/embed.js

## Hyperedges (group relationships)
- **Repeated session-resolve + message-persist + usage-track pattern in embed.js** — embed_ask_handler, embed_study_handler, embed_log_handler [INFERRED 0.85]
- **Owner-bank-first, RAG-grounded study tool generation** — tools_handlegeneratequiz, tools_handlegenerateflashcards, embed_embedone, vector_searchproject [EXTRACTED 1.00]
- **Durable learner identity resolution and backfill across progress tables** — learner_resolvelearnerkey, learner_backfilllearnerkey, schema_quiz_attempts, schema_flashcard_reviews, schema_leads [EXTRACTED 1.00]
- **Knowledge source ingestion pipeline: extract to chunk to embed to persist** — process_processfile, extract_extractfile, chunk_chunkpages, embed_embedmany, pageimages_processpdfpageimages [EXTRACTED 1.00]
- **Two parallel lip-sync pipeline implementations (monolithic vs modular)** — lipsync_sdk_lipsyncavatar, hybrid_lipsync_controller_hybridlipsynccontroller, audio_clock_audioclock, viseme_map_visememap, amplitude_fallback_amplitudefallback [INFERRED 0.85]
- **Three inconsistently-documented widget embedding mechanisms** — lipsync_sdk_lipsyncavatar, embed_loader_mount, react_avatarwidget [INFERRED 0.75]
- **Approved design spec → implementation plan → shipped code (lipsync timing/emotions feature)** — 2026_07_04_lipsync_timing_and_emotions_design_designspec, 2026_07_04_lipsync_timing_and_emotions_plan, lipsync_sdk_schedulefromtext, lipsync_sdk_characterbehaviorcontroller [EXTRACTED 1.00]
- **Advanced-Tier Study Tools (Quiz + Flashcards Gated by Capability Tier)** — project_capability_tier_design, embed_study_route, embed_quiz_attempt_route [INFERRED 0.75]
- **End-to-End Embed Workflow: Architecture, Dashboard, Script Snippet, Runtime Widget** — docsindex_architecture_overview, project_page, embed_widget_page, index_script_embed_snippet [INFERRED 0.75]
- **Pluggable Voice Engine Abstraction Over Shared Lip-Sync Pipeline** — gemini_live_doc, openai_realtime_doc, elevenlabs_avatar_doc, natural_lipsync_doc [INFERRED 0.85]
- **Push-Triggered Resync Pattern** — d21ea483_b225_412d_b06f_566664efe29c_nodejs_backend, d21ea483_b225_412d_b06f_566664efe29c_firebase_cloud_messaging, d21ea483_b225_412d_b06f_566664efe29c_flutter_app [EXTRACTED 1.00]
- **Required Aircraft Flight Documentation Set** — c21ddb7b_839d_4f7c_bdc1_836203b23923_afm_poh, c21ddb7b_839d_4f7c_bdc1_836203b23923_certificate_of_aircraft_registration, c21ddb7b_839d_4f7c_bdc1_836203b23923_standard_airworthiness_certificate, c21ddb7b_839d_4f7c_bdc1_836203b23923_airworthiness_directives_ads [EXTRACTED 1.00]
- **Real-World Knowledge Domain Behind the PPAER Exam** — 9c0c64b0_de01_4231_b91c_db014999b6d1_ppaer_exam, 9c0c64b0_de01_4231_b91c_db014999b6d1_cars_regulations, 9c0c64b0_de01_4231_b91c_db014999b6d1_canada_flight_supplement_cfs, 20222c3b_3fcb_4ed5_bbfb_cc23f8417c28_pitt_meadows_airport [INFERRED 0.85]

## Communities (72 total, 27 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (70): Account Settings Page, API object (REST endpoint helper namespace), Audio Clock / Phoneme Scheduler, Characters Gallery Page, Autoplay Rive Character Preview (no Gemini connection, emoji fallback), Cal.com Booking Embed Integration, Contact Page, Duplicate Project Action (+62 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (27): anyTextToAzureIds(), arabicG2P, AZ_COLOR, AZ_IMPORTANCE, AZ_LABEL, bengaliG2P, chineseG2P, clamp01() (+19 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (44): _, a, _addMsg(), _applyVisemeTargets(), b, c(), connect(), constructor() (+36 more)

### Community 3 - "Community 3"
Cohesion: 0.05
Nodes (52): POST /create-checkout-session handler, GET /plans handler, GET /subscription handler, GET /usage handler, chunkPages, chunkText, extractHeading, splitOnSentences (+44 more)

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (41): buildFilter(), camelToSnake(), findAll(), findOne(), insert(), insertMany(), logger, NATIVE_ARRAY_COLUMNS (+33 more)

### Community 5 - "Community 5"
Cohesion: 0.04
Nodes (43): allowedKeys, byTopic, calls, { CHARACTERS }, chat, chunks, contextParts, crypto (+35 more)

### Community 6 - "Community 6"
Cohesion: 0.1
Nodes (6): CharacterBehaviorController, clamp(), clamp01(), easeInOut3(), easeOut2(), HybridLipSyncController

### Community 7 - "Community 7"
Cohesion: 0.05
Nodes (34): logger, pino, allowed, analyticsRoutes, apiLimiter, app, authLimiter, authRoutes (+26 more)

### Community 8 - "Community 8"
Cohesion: 0.06
Nodes (32): { authRequired }, created, csvUpload, db, err, express, multer, { parseFlashcardCsv } (+24 more)

### Community 9 - "Community 9"
Cohesion: 0.1
Nodes (29): getPlan(), planByStripePriceId(), PLANS, { authRequired }, db, express, { getStripe, isConfigured }, { getUsageSnapshot, userPlanId } (+21 more)

### Community 10 - "Community 10"
Cohesion: 0.09
Nodes (25): Analytics Router, authRequired middleware, Auth Router, POST /create-portal-session handler, Billing Router, syncSubscriptionFromEvent(), webhookHandler(), invalidateProjectCache (+17 more)

### Community 11 - "Community 11"
Cohesion: 0.09
Nodes (27): email, password, schemas, validate(), { z }, bcrypt, crypto, db (+19 more)

### Community 12 - "Community 12"
Cohesion: 0.1
Nodes (29): Design rationale: byte-clock-windowed viseme timing, Spec: Lip-sync timing accuracy & multilingual emotion reactions, Design rationale: multilingual, priority-ordered emotion reactions, Rejected: Gemini structured emotion tags & translation mode, Plan: Lip-sync Timing Accuracy & Multilingual Emotions, AmplitudeFallback class, AudioClock class, CharacterBehaviorController class (hybrid-lipsync-controller.js) (+21 more)

### Community 13 - "Community 13"
Cohesion: 0.1
Nodes (28): advanced-features-prompts.md — Prompt 0: capability tier foundation, advanced-features-prompts.md — Prompt 1: tool-calling infrastructure, advanced-features-prompts.md — Prompt 2: RAG-grounded quiz generation, advanced-features-prompts.md — Prompt 3: RAG-grounded flashcards, advanced-features-prompts.md — Prompt 4: progress tracking, parseCsvRows, parseFlashcardCsv, parseQuizCsv (+20 more)

### Community 14 - "Community 14"
Cohesion: 0.13
Nodes (23): AUDIO_EXT, classify(), DOC_EXT, DOCX_EXT, extractAudio(), extractDoc(), extractDocx(), extractFile() (+15 more)

### Community 15 - "Community 15"
Cohesion: 0.09
Nodes (24): Pitt Meadows Airport (CYPK), ARCAL Pilot-Controlled Runway Lighting (126.3), Pitt Meadows Heliport Parking Pads (1/2/3), VOR YPK Navigation Aid (112.4), Aeronautics - General Knowledge (exam subject), Air Law and Procedure (exam subject), Canada Flight Supplement (CFS), Canadian Aviation Regulations (CARs) (+16 more)

### Community 16 - "Community 16"
Cohesion: 0.09
Nodes (19): { authRequired }, { checkLimit }, { classify }, created, db, express, fs, kind (+11 more)

### Community 18 - "Community 18"
Cohesion: 0.1
Nodes (18): allowed, { authRequired }, CHARACTERS, { checkLimit }, crypto, db, enriched, express (+10 more)

### Community 20 - "Community 20"
Cohesion: 0.15
Nodes (14): embedOne(), db, { embedOne }, FLASHCARD_SCHEMA, { GoogleGenerativeAI }, handleGenerateFlashcards(), handleGenerateQuiz(), { meetsTier } (+6 more)

### Community 21 - "Community 21"
Cohesion: 0.18
Nodes (15): chunkPages(), chunkText(), extractHeading(), splitOnSentences(), { chunkText, chunkPages }, db, { embedMany, MODEL: EMBED_MODEL, OUTPUT_DIM: EMBED_DIM }, emit() (+7 more)

### Community 22 - "Community 22"
Cohesion: 0.27
Nodes (15): buildFilter(), camelToSnake(), findAll(), findOne(), insert(), insertMany(), NATIVE_ARRAY_COLUMNS set, Postgres connection Pool (+7 more)

### Community 24 - "Community 24"
Cohesion: 0.2
Nodes (14): Android WorkManager Geofence Check, AvatarPlatform (referenced sibling project), Claude API Email-Parsing Fallback, Fail-Open Failure Handling Principle, Firebase Cloud Messaging (data-only push), Flight Booking Reminder Architecture, Flutter App (reminder engine client), Gmail History API polling (+6 more)

### Community 25 - "Community 25"
Cohesion: 0.18
Nodes (8): COMMON_WORDS_EN, detectLang(), englishG2P(), GROUP_DURATION_BASE, LANG_TIMING, PHONEME_GROUP, RIVE_INPUT_BY_GROUP, VisemeMap

### Community 26 - "Community 26"
Cohesion: 0.2
Nodes (11): classifyAndCaption(), db, fs, { GoogleGenerativeAI }, logger, MAX_PAGES, path, processPdfPageImages() (+3 more)

### Community 27 - "Community 27"
Cohesion: 0.24
Nodes (6): all, createPlaceholder(), loadSavedPosition(), mount(), publicId, SRC

### Community 29 - "Community 29"
Cohesion: 0.22
Nodes (9): POST /:publicId/flashcard-review handler, POST /:publicId/lead handler, POST /:publicId/quiz-attempt handler, backfillLearnerKey, resolveLearnerKey, capture_fields table, flashcard_reviews table, leads table (+1 more)

### Community 30 - "Community 30"
Cohesion: 0.25
Nodes (8): auth routes child logger, billing routes child logger, db module child logger, embed routes child logger, Pino Logger Instance, Global error-handling middleware, app.listen() startup callback, shutdown() graceful-exit handler

### Community 31 - "Community 31"
Cohesion: 0.33
Nodes (6): embedCache, embedMany(), fetch, logger, { LRUCache }, OUTPUT_DIM

### Community 32 - "Community 32"
Cohesion: 0.33
Nodes (4): FEATURES_BY_TIER, isValidTier(), meetsTier(), TIERS

### Community 33 - "Community 33"
Cohesion: 0.33
Nodes (6): POST /forgot-password handler, POST /signup handler, getTransport, send, sendPasswordReset, sendWelcome

### Community 34 - "Community 34"
Cohesion: 0.6
Nodes (4): cheerio, fetch, fetchUrl(), parseHtml()

### Community 35 - "Community 35"
Cohesion: 0.4
Nodes (5): Airplane Flight Manual / Pilot's Operating Handbook (AFM/POH), Airworthiness Directives (ADs), GAMA Specification No. 1 (flight-manual format standard), Minimum Equipment List (MEL) / 91.213(d) deferral, Preventive Maintenance (14 CFR part 43, appendix A(c))

### Community 36 - "Community 36"
Cohesion: 0.67
Nodes (3): backfillLearnerKey(), db, resolveLearnerKey()

### Community 37 - "Community 37"
Cohesion: 0.5
Nodes (3): invalidateProjectCache(), { LRUCache }, projectCache

### Community 39 - "Community 39"
Cohesion: 0.67
Nodes (3): advanced-features-prompts.md — Prompt 5: referenced images/diagrams/PDF page links, advanced-features-prompts.md — Prompt 7: slide viewer, chunk.js pageHint field (known-broken, always 1)

### Community 40 - "Community 40"
Cohesion: 0.67
Nodes (3): Character Files README, Rive Character Files (character_1-4.riv), Viseme Inputs 100-122 (lip-sync)

### Community 41 - "Community 41"
Cohesion: 0.67
Nodes (3): Certificate of Aircraft Registration (AC Form 8050-3), Special Airworthiness Certificate / Special Flight Permit (FAA Form 8130-7), Standard Airworthiness Certificate (FAA Form 8100-2)

### Community 42 - "Community 42"
Cohesion: 0.67
Nodes (3): Annual Inspection, Emergency Locator Transmitter (ELT), 100-Hour Inspection

## Ambiguous Edges - Review These
- `GET /:publicId/config Route` → `Documented /embed/:publicId/tts Proxy Route (unverified in code)`  [AMBIGUOUS]
  backend/routes/embed.js · relation: conceptually_related_to
- `LipsyncAvatar class` → `AvatarWidget React component`  [AMBIGUOUS]
  public/sdk/react.js · relation: conceptually_related_to
- `embed-loader.js mount() iframe/FAB bootstrapper` → `project.md — Embed Widget section`  [AMBIGUOUS]
  project.md · relation: conceptually_related_to

## Knowledge Gaps
- **400 isolated node(s):** `pino`, `logger`, `{ LRUCache }`, `express`, `cors` (+395 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **27 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `GET /:publicId/config Route` and `Documented /embed/:publicId/tts Proxy Route (unverified in code)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `LipsyncAvatar class` and `AvatarWidget React component`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `embed-loader.js mount() iframe/FAB bootstrapper` and `project.md — Embed Widget section`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `LipsyncAvatar class` connect `Community 0` to `Community 12`, `Community 13`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Why does `advanced-features-prompts.md — Prompt 1: tool-calling infrastructure` connect `Community 13` to `Community 0`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **What connects `pino`, `logger`, `{ LRUCache }` to the rest of the system?**
  _400 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._