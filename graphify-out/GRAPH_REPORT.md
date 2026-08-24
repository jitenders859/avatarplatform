# Graph Report - .  (2026-08-24)

## Corpus Check
- 76 files · ~75,505 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 978 nodes · 1455 edges · 72 communities (45 shown, 27 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 44 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Multilingual VisemeG2P Engine|Multilingual Viseme/G2P Engine]]
- [[_COMMUNITY_Minified Production LipSync Bundle|Minified Production LipSync Bundle]]
- [[_COMMUNITY_Billing Routes & Document Chunking|Billing Routes & Document Chunking]]
- [[_COMMUNITY_PPL Flight Test Guide (TP 13723E)|PPL Flight Test Guide (TP 13723E)]]
- [[_COMMUNITY_Embed Widget Chat Route|Embed Widget Chat Route]]
- [[_COMMUNITY_Character Behavior Controller (Hybrid)|Character Behavior Controller (Hybrid)]]
- [[_COMMUNITY_RAG Query Helpers & Vector Search|RAG Query Helpers & Vector Search]]
- [[_COMMUNITY_Billing & Subscription Tiers|Billing & Subscription Tiers]]
- [[_COMMUNITY_Cross-Route Auth & Billing Handlers|Cross-Route Auth & Billing Handlers]]
- [[_COMMUNITY_Request Validation & Email Auth|Request Validation & Email Auth]]
- [[_COMMUNITY_Express Server Bootstrap & Middleware|Express Server Bootstrap & Middleware]]
- [[_COMMUNITY_Advanced Features Roadmap & CSV Parsing|Advanced Features Roadmap & CSV Parsing]]
- [[_COMMUNITY_File Content Extraction (PDFDOCXAudio)|File Content Extraction (PDF/DOCX/Audio)]]
- [[_COMMUNITY_Aviation Reference Documents (CFSCARs)|Aviation Reference Documents (CFS/CARs)]]
- [[_COMMUNITY_File Upload Route|File Upload Route]]
- [[_COMMUNITY_Quiz Questions Route|Quiz Questions Route]]
- [[_COMMUNITY_Projects Route|Projects Route]]
- [[_COMMUNITY_Character Behavior Controller (Minified)|Character Behavior Controller (Minified)]]
- [[_COMMUNITY_Character Behavior Controller (Legacy SDK)|Character Behavior Controller (Legacy SDK)]]
- [[_COMMUNITY_Marketing Pages & React SDK Integration|Marketing Pages & React SDK Integration]]
- [[_COMMUNITY_PPL Flight Test Exercises (TakeoffLanding)|PPL Flight Test Exercises (Takeoff/Landing)]]
- [[_COMMUNITY_Document Chunking Pipeline|Document Chunking Pipeline]]
- [[_COMMUNITY_Lip-Sync & TTS Provider Docs|Lip-Sync & TTS Provider Docs]]
- [[_COMMUNITY_Postgres Query Builder|Postgres Query Builder]]
- [[_COMMUNITY_Lip-Sync Timing & Emotion Design Docs|Lip-Sync Timing & Emotion Design Docs]]
- [[_COMMUNITY_Flashcards Route|Flashcards Route]]
- [[_COMMUNITY_Audio Clock  Playback Scheduler|Audio Clock / Playback Scheduler]]
- [[_COMMUNITY_Flight Booking Reminder App (Sibling Project)|Flight Booking Reminder App (Sibling Project)]]
- [[_COMMUNITY_Viseme Mapping & Language Detection|Viseme Mapping & Language Detection]]
- [[_COMMUNITY_PDF Page Image Captioning|PDF Page Image Captioning]]
- [[_COMMUNITY_Embed Widget Study & Quiz Routes|Embed Widget Study & Quiz Routes]]
- [[_COMMUNITY_Lip-Sync Module Inventory (Task Notes)|Lip-Sync Module Inventory (Task Notes)]]
- [[_COMMUNITY_Analytics Route & Auth Middleware|Analytics Route & Auth Middleware]]
- [[_COMMUNITY_Capture Fields Route|Capture Fields Route]]
- [[_COMMUNITY_Embed Loader (IframeFAB Bootstrap)|Embed Loader (Iframe/FAB Bootstrap)]]
- [[_COMMUNITY_Amplitude Fallback Lip-Sync|Amplitude Fallback Lip-Sync]]
- [[_COMMUNITY_Project Reference Docs & Embed Loader|Project Reference Docs & Embed Loader]]
- [[_COMMUNITY_Video Resources Route|Video Resources Route]]
- [[_COMMUNITY_Dashboard & Account Pages|Dashboard & Account Pages]]
- [[_COMMUNITY_Frontend API Helper & Progress Socket|Frontend API Helper & Progress Socket]]
- [[_COMMUNITY_Per-Route Loggers & Server Lifecycle|Per-Route Loggers & Server Lifecycle]]
- [[_COMMUNITY_Gemini Embedding Service|Gemini Embedding Service]]
- [[_COMMUNITY_Capability Tiers|Capability Tiers]]
- [[_COMMUNITY_Password Reset Flow|Password Reset Flow]]
- [[_COMMUNITY_ElevenLabs Integration Docs (Unverified Route)|ElevenLabs Integration Docs (Unverified Route)]]
- [[_COMMUNITY_CSV Import Parsing|CSV Import Parsing]]
- [[_COMMUNITY_Aviation Maintenance Docs|Aviation Maintenance Docs]]
- [[_COMMUNITY_Project LRU Cache|Project LRU Cache]]
- [[_COMMUNITY_PPL Test Regulatory Basis (CARsExaminer)|PPL Test Regulatory Basis (CARs/Examiner)]]
- [[_COMMUNITY_Pino Logger Setup|Pino Logger Setup]]
- [[_COMMUNITY_Aircraft Inspection Requirements|Aircraft Inspection Requirements]]
- [[_COMMUNITY_PPL Test Marking Scale (ErrorsDeviations)|PPL Test Marking Scale (Errors/Deviations)]]
- [[_COMMUNITY_PPL Flight Test Exercise Stall|PPL Flight Test Exercise: Stall]]
- [[_COMMUNITY_Project Cache Lookup|Project Cache Lookup]]
- [[_COMMUNITY_AccountProject Deletion Handlers|Account/Project Deletion Handlers]]
- [[_COMMUNITY_Embed Config Handler|Embed Config Handler]]
- [[_COMMUNITY_Embed File & Page-Image Handlers|Embed File & Page-Image Handlers]]
- [[_COMMUNITY_PPL Test Privacy Handling|PPL Test Privacy Handling]]
- [[_COMMUNITY_DB Key Casing Helper|DB Key Casing Helper]]
- [[_COMMUNITY_Flashcards Ownership Middleware|Flashcards Ownership Middleware]]
- [[_COMMUNITY_Files Ownership Middleware|Files Ownership Middleware]]
- [[_COMMUNITY_File Response Stripping|File Response Stripping]]
- [[_COMMUNITY_Login Handler|Login Handler]]
- [[_COMMUNITY_Video Resources Ownership Middleware|Video Resources Ownership Middleware]]
- [[_COMMUNITY_Embed Citation File Lookup|Embed Citation File Lookup]]

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

### Community 0 - "Multilingual Viseme/G2P Engine"
Cohesion: 0.05
Nodes (70): Account Settings Page, API object (REST endpoint helper namespace), Audio Clock / Phoneme Scheduler, Characters Gallery Page, Autoplay Rive Character Preview (no Gemini connection, emoji fallback), Cal.com Booking Embed Integration, Contact Page, Duplicate Project Action (+62 more)

### Community 1 - "Minified Production LipSync Bundle"
Cohesion: 0.05
Nodes (27): anyTextToAzureIds(), arabicG2P, AZ_COLOR, AZ_IMPORTANCE, AZ_LABEL, bengaliG2P, chineseG2P, clamp01() (+19 more)

### Community 2 - "Billing Routes & Document Chunking"
Cohesion: 0.06
Nodes (44): _, a, _addMsg(), _applyVisemeTargets(), b, c(), connect(), constructor() (+36 more)

### Community 3 - "PPL Flight Test Guide (TP 13723E)"
Cohesion: 0.05
Nodes (52): POST /create-checkout-session handler, GET /plans handler, GET /subscription handler, GET /usage handler, chunkPages, chunkText, extractHeading, splitOnSentences (+44 more)

### Community 4 - "Embed Widget Chat Route"
Cohesion: 0.07
Nodes (41): buildFilter(), camelToSnake(), findAll(), findOne(), insert(), insertMany(), logger, NATIVE_ARRAY_COLUMNS (+33 more)

### Community 5 - "Character Behavior Controller (Hybrid)"
Cohesion: 0.04
Nodes (43): allowedKeys, byTopic, calls, { CHARACTERS }, chat, chunks, contextParts, crypto (+35 more)

### Community 6 - "RAG Query Helpers & Vector Search"
Cohesion: 0.1
Nodes (6): CharacterBehaviorController, clamp(), clamp01(), easeInOut3(), easeOut2(), HybridLipSyncController

### Community 7 - "Billing & Subscription Tiers"
Cohesion: 0.05
Nodes (34): logger, pino, allowed, analyticsRoutes, apiLimiter, app, authLimiter, authRoutes (+26 more)

### Community 8 - "Cross-Route Auth & Billing Handlers"
Cohesion: 0.06
Nodes (32): { authRequired }, created, csvUpload, db, err, express, multer, { parseFlashcardCsv } (+24 more)

### Community 9 - "Request Validation & Email Auth"
Cohesion: 0.1
Nodes (29): getPlan(), planByStripePriceId(), PLANS, { authRequired }, db, express, { getStripe, isConfigured }, { getUsageSnapshot, userPlanId } (+21 more)

### Community 10 - "Express Server Bootstrap & Middleware"
Cohesion: 0.09
Nodes (25): Analytics Router, authRequired middleware, Auth Router, POST /create-portal-session handler, Billing Router, syncSubscriptionFromEvent(), webhookHandler(), invalidateProjectCache (+17 more)

### Community 11 - "Advanced Features Roadmap & CSV Parsing"
Cohesion: 0.09
Nodes (27): email, password, schemas, validate(), { z }, bcrypt, crypto, db (+19 more)

### Community 12 - "File Content Extraction (PDF/DOCX/Audio)"
Cohesion: 0.1
Nodes (29): Design rationale: byte-clock-windowed viseme timing, Spec: Lip-sync timing accuracy & multilingual emotion reactions, Design rationale: multilingual, priority-ordered emotion reactions, Rejected: Gemini structured emotion tags & translation mode, Plan: Lip-sync Timing Accuracy & Multilingual Emotions, AmplitudeFallback class, AudioClock class, CharacterBehaviorController class (hybrid-lipsync-controller.js) (+21 more)

### Community 13 - "Aviation Reference Documents (CFS/CARs)"
Cohesion: 0.1
Nodes (28): advanced-features-prompts.md — Prompt 0: capability tier foundation, advanced-features-prompts.md — Prompt 1: tool-calling infrastructure, advanced-features-prompts.md — Prompt 2: RAG-grounded quiz generation, advanced-features-prompts.md — Prompt 3: RAG-grounded flashcards, advanced-features-prompts.md — Prompt 4: progress tracking, parseCsvRows, parseFlashcardCsv, parseQuizCsv (+20 more)

### Community 14 - "File Upload Route"
Cohesion: 0.13
Nodes (23): AUDIO_EXT, classify(), DOC_EXT, DOCX_EXT, extractAudio(), extractDoc(), extractDocx(), extractFile() (+15 more)

### Community 15 - "Quiz Questions Route"
Cohesion: 0.09
Nodes (24): Pitt Meadows Airport (CYPK), ARCAL Pilot-Controlled Runway Lighting (126.3), Pitt Meadows Heliport Parking Pads (1/2/3), VOR YPK Navigation Aid (112.4), Aeronautics - General Knowledge (exam subject), Air Law and Procedure (exam subject), Canada Flight Supplement (CFS), Canadian Aviation Regulations (CARs) (+16 more)

### Community 16 - "Projects Route"
Cohesion: 0.09
Nodes (19): { authRequired }, { checkLimit }, { classify }, created, db, express, fs, kind (+11 more)

### Community 18 - "Character Behavior Controller (Legacy SDK)"
Cohesion: 0.1
Nodes (18): allowed, { authRequired }, CHARACTERS, { checkLimit }, crypto, db, enriched, express (+10 more)

### Community 20 - "PPL Flight Test Exercises (Takeoff/Landing)"
Cohesion: 0.15
Nodes (14): embedOne(), db, { embedOne }, FLASHCARD_SCHEMA, { GoogleGenerativeAI }, handleGenerateFlashcards(), handleGenerateQuiz(), { meetsTier } (+6 more)

### Community 21 - "Document Chunking Pipeline"
Cohesion: 0.18
Nodes (15): chunkPages(), chunkText(), extractHeading(), splitOnSentences(), { chunkText, chunkPages }, db, { embedMany, MODEL: EMBED_MODEL, OUTPUT_DIM: EMBED_DIM }, emit() (+7 more)

### Community 22 - "Lip-Sync & TTS Provider Docs"
Cohesion: 0.27
Nodes (15): buildFilter(), camelToSnake(), findAll(), findOne(), insert(), insertMany(), NATIVE_ARRAY_COLUMNS set, Postgres connection Pool (+7 more)

### Community 24 - "Lip-Sync Timing & Emotion Design Docs"
Cohesion: 0.2
Nodes (14): Android WorkManager Geofence Check, AvatarPlatform (referenced sibling project), Claude API Email-Parsing Fallback, Fail-Open Failure Handling Principle, Firebase Cloud Messaging (data-only push), Flight Booking Reminder Architecture, Flutter App (reminder engine client), Gmail History API polling (+6 more)

### Community 25 - "Flashcards Route"
Cohesion: 0.18
Nodes (8): COMMON_WORDS_EN, detectLang(), englishG2P(), GROUP_DURATION_BASE, LANG_TIMING, PHONEME_GROUP, RIVE_INPUT_BY_GROUP, VisemeMap

### Community 26 - "Audio Clock / Playback Scheduler"
Cohesion: 0.2
Nodes (11): classifyAndCaption(), db, fs, { GoogleGenerativeAI }, logger, MAX_PAGES, path, processPdfPageImages() (+3 more)

### Community 27 - "Flight Booking Reminder App (Sibling Project)"
Cohesion: 0.24
Nodes (6): all, createPlaceholder(), loadSavedPosition(), mount(), publicId, SRC

### Community 29 - "PDF Page Image Captioning"
Cohesion: 0.22
Nodes (9): POST /:publicId/flashcard-review handler, POST /:publicId/lead handler, POST /:publicId/quiz-attempt handler, backfillLearnerKey, resolveLearnerKey, capture_fields table, flashcard_reviews table, leads table (+1 more)

### Community 30 - "Embed Widget Study & Quiz Routes"
Cohesion: 0.25
Nodes (8): auth routes child logger, billing routes child logger, db module child logger, embed routes child logger, Pino Logger Instance, Global error-handling middleware, app.listen() startup callback, shutdown() graceful-exit handler

### Community 31 - "Lip-Sync Module Inventory (Task Notes)"
Cohesion: 0.33
Nodes (6): embedCache, embedMany(), fetch, logger, { LRUCache }, OUTPUT_DIM

### Community 32 - "Analytics Route & Auth Middleware"
Cohesion: 0.33
Nodes (4): FEATURES_BY_TIER, isValidTier(), meetsTier(), TIERS

### Community 33 - "Capture Fields Route"
Cohesion: 0.33
Nodes (6): POST /forgot-password handler, POST /signup handler, getTransport, send, sendPasswordReset, sendWelcome

### Community 34 - "Embed Loader (Iframe/FAB Bootstrap)"
Cohesion: 0.6
Nodes (4): cheerio, fetch, fetchUrl(), parseHtml()

### Community 35 - "Amplitude Fallback Lip-Sync"
Cohesion: 0.4
Nodes (5): Airplane Flight Manual / Pilot's Operating Handbook (AFM/POH), Airworthiness Directives (ADs), GAMA Specification No. 1 (flight-manual format standard), Minimum Equipment List (MEL) / 91.213(d) deferral, Preventive Maintenance (14 CFR part 43, appendix A(c))

### Community 36 - "Project Reference Docs & Embed Loader"
Cohesion: 0.67
Nodes (3): backfillLearnerKey(), db, resolveLearnerKey()

### Community 37 - "Video Resources Route"
Cohesion: 0.5
Nodes (3): invalidateProjectCache(), { LRUCache }, projectCache

### Community 39 - "Dashboard & Account Pages"
Cohesion: 0.67
Nodes (3): advanced-features-prompts.md — Prompt 5: referenced images/diagrams/PDF page links, advanced-features-prompts.md — Prompt 7: slide viewer, chunk.js pageHint field (known-broken, always 1)

### Community 40 - "Frontend API Helper & Progress Socket"
Cohesion: 0.67
Nodes (3): Character Files README, Rive Character Files (character_1-4.riv), Viseme Inputs 100-122 (lip-sync)

### Community 41 - "Per-Route Loggers & Server Lifecycle"
Cohesion: 0.67
Nodes (3): Certificate of Aircraft Registration (AC Form 8050-3), Special Airworthiness Certificate / Special Flight Permit (FAA Form 8130-7), Standard Airworthiness Certificate (FAA Form 8100-2)

### Community 42 - "Gemini Embedding Service"
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
- **Why does `LipsyncAvatar class` connect `Multilingual Viseme/G2P Engine` to `File Content Extraction (PDF/DOCX/Audio)`, `Aviation Reference Documents (CFS/CARs)`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Why does `advanced-features-prompts.md — Prompt 1: tool-calling infrastructure` connect `Aviation Reference Documents (CFS/CARs)` to `Multilingual Viseme/G2P Engine`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **What connects `pino`, `logger`, `{ LRUCache }` to the rest of the system?**
  _400 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Multilingual Viseme/G2P Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._