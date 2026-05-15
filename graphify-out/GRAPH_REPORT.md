# Graph Report - /Users/uhkjjkhjh/Downloads/avatar-platform 2  (2026-05-13)

## Corpus Check
- Corpus is ~20,653 words - fits in a single context window. You may not need a graph.

## Summary
- 318 nodes · 492 edges · 13 communities (12 shown, 1 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 10 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Frontend Pages & Character Assets|Frontend Pages & Character Assets]]
- [[_COMMUNITY_LipsyncAvatar SDK Core|LipsyncAvatar SDK Core]]
- [[_COMMUNITY_Billing & Plans System|Billing & Plans System]]
- [[_COMMUNITY_Auth & Analytics Routes|Auth & Analytics Routes]]
- [[_COMMUNITY_Server & Route Registry|Server & Route Registry]]
- [[_COMMUNITY_Embed API & Vector Search|Embed API & Vector Search]]
- [[_COMMUNITY_File Upload & Management|File Upload & Management]]
- [[_COMMUNITY_Phoneme & Viseme Processing|Phoneme & Viseme Processing]]
- [[_COMMUNITY_Content Extraction Pipeline|Content Extraction Pipeline]]
- [[_COMMUNITY_RAG Processing Pipeline|RAG Processing Pipeline]]
- [[_COMMUNITY_JSON File Database|JSON File Database]]
- [[_COMMUNITY_Embed Loader Script|Embed Loader Script]]
- [[_COMMUNITY_Frontend API Utilities|Frontend API Utilities]]

## God Nodes (most connected - your core abstractions)
1. `LipsyncAvatar` - 35 edges
2. `Public Chat Widget (embed.html)` - 13 edges
3. `extractFile()` - 11 edges
4. `anyTextToAzureIds()` - 10 edges
5. `Billing & Usage Page (billing.html)` - 9 edges
6. `app.css (Dark SaaS Theme)` - 9 edges
7. `AvatarPlatform` - 8 edges
8. `Landing Page (index.html)` - 8 edges
9. `api.js (Fetch Wrapper + Auth + Toast)` - 8 edges
10. `Rive Runtime (Lip-sync)` - 7 edges

## Surprising Connections (you probably didn't know these)
- `Viseme Inputs 100-122 (lip-sync)` --references--> `Rive Runtime (Lip-sync)`  [INFERRED]
  public/assets/characters/README.md → README.md
- `Gemini Live Voice List (30 voices)` --references--> `Gemini Live (Speech-to-Speech)`  [INFERRED]
  public/project.html → README.md
- `Billing & Usage Page (billing.html)` --references--> `Stripe Billing Integration`  [EXTRACTED]
  public/billing.html → README.md
- `Billing & Usage Page (billing.html)` --references--> `Free Plan Tier`  [EXTRACTED]
  public/billing.html → README.md
- `Billing & Usage Page (billing.html)` --references--> `Starter Plan Tier`  [EXTRACTED]
  public/billing.html → README.md

## Hyperedges (group relationships)
- **RAG Pipeline: Embed -> Retrieve -> Inject into LipsyncAvatar** — readme_text_embedding_004, readme_in_memory_vector_store, embed_rag_retrieve_endpoint, embed_lipsync_avatar_class, embed_source_cards [EXTRACTED 0.95]
- **Talking Avatar Stack: Rive Runtime + Gemini Live + LipsyncAvatar SDK** — readme_rive_runtime, readme_gemini_live, readme_lipsync_sdk, embed_lipsync_avatar_class, characters_rive_files, characters_viseme_inputs [EXTRACTED 0.95]
- **SaaS Plan & Billing System: Plans + Stripe + Usage Enforcement** — readme_plan_free, readme_plan_starter, readme_plan_pro, readme_plan_business, readme_stripe, billing_billing_page, pricing_pricing_page [EXTRACTED 0.95]

## Communities (13 total, 1 thin omitted)

### Community 0 - "Frontend Pages & Character Assets"
Cohesion: 0.1
Nodes (40): Analytics Page (analytics.html), Billing & Usage Page (billing.html), Character Files README, Rive Character Files (character_1-4.riv), Viseme Inputs 100-122 (lip-sync), Dashboard Page (dashboard.html), Public Config /embed/{id}/config Endpoint, Public Chat Widget (embed.html) (+32 more)

### Community 1 - "LipsyncAvatar SDK Core"
Cohesion: 0.1
Nodes (4): clamp01(), easeInOutCubic(), easeOutCubic(), LipsyncAvatar

### Community 2 - "Billing & Plans System"
Cohesion: 0.1
Nodes (29): getPlan(), planByStripePriceId(), PLANS, { authRequired }, db, express, { getStripe, isConfigured }, { getUsageSnapshot, userPlanId } (+21 more)

### Community 3 - "Auth & Analytics Routes"
Cohesion: 0.07
Nodes (28): authRequired(), db, jwt, signToken(), { authRequired }, buckets, byProject, day (+20 more)

### Community 4 - "Server & Route Registry"
Cohesion: 0.07
Nodes (25): analyticsRoutes, app, authRoutes, cors, embedRoutes, express, filesRoutes, PAGES (+17 more)

### Community 5 - "Embed API & Vector Search"
Cohesion: 0.09
Nodes (23): buckets, { CHARACTERS }, chunks, db, { embedOne }, express, file, fileCache (+15 more)

### Community 6 - "File Upload & Management"
Cohesion: 0.08
Nodes (23): { authRequired }, { checkLimit }, { classify }, created, db, express, file, fileCheck (+15 more)

### Community 7 - "Phoneme & Viseme Processing"
Cohesion: 0.11
Nodes (20): anyTextToAzureIds(), arabicG2P, AZ_COLOR, AZ_IMPORTANCE, AZ_LABEL, bengaliG2P, chineseG2P, COMMON_WORDS (+12 more)

### Community 8 - "Content Extraction Pipeline"
Cohesion: 0.13
Nodes (23): AUDIO_EXT, classify(), DOC_EXT, DOCX_EXT, extractAudio(), extractDoc(), extractDocx(), extractFile() (+15 more)

### Community 9 - "RAG Processing Pipeline"
Cohesion: 0.14
Nodes (17): chunkText(), embedMany(), embedOne(), fetch, { chunkText }, db, { embedMany }, { extractFile } (+9 more)

### Community 10 - "JSON File Database"
Cohesion: 0.26
Nodes (12): DATA_DIR, findAll(), findOne(), fs, insert(), locks, path, readTable() (+4 more)

### Community 11 - "Embed Loader Script"
Cohesion: 0.4
Nodes (5): all, mount(), mountFallback(), publicId, SRC

## Knowledge Gaps
- **148 isolated node(s):** `express`, `cors`, `path`, `authRoutes`, `{ router: projectsRoutes }` (+143 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `LipsyncAvatar` connect `LipsyncAvatar SDK Core` to `Phoneme & Viseme Processing`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Why does `authRequired()` connect `Auth & Analytics Routes` to `Billing & Plans System`, `Server & Route Registry`, `File Upload & Management`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **What connects `express`, `cors`, `path` to the rest of the system?**
  _148 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Frontend Pages & Character Assets` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `LipsyncAvatar SDK Core` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Billing & Plans System` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Auth & Analytics Routes` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._