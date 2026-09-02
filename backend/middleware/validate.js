const { z } = require('zod');
const { TIERS: CAPABILITY_TIERS } = require('../services/tiers');

/**
 * validate(schema) — express middleware factory.
 * Parses req.body against a Zod schema. On failure returns 400 with the
 * first error message and field name. On success replaces req.body with
 * the coerced, stripped output (unknown keys removed).
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = (result.error.issues ?? result.error.errors)[0];
      return res.status(400).json({
        error: first.message,
        field: first.path[0] ?? null,
      });
    }
    req.body = result.data;
    next();
  };
}

// ── Shared schemas ────────────────────────────────────────────
const email = z.string().email('Invalid email address').toLowerCase().trim();
const password = z.string().min(8, 'Password must be at least 8 characters');

// 30 Gemini Live voices — kept in sync with public/project.html's VOICES list.
const VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Autonoe', 'Callirrhoe', 'Despina', 'Enceladus', 'Erinome', 'Gacrux', 'Iapetus', 'Laomedeia', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zubenelgenubi'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const YOUTUBE_URL_RE = /^https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/;
const CAPTURE_FIELD_TYPES = ['text', 'email', 'phone', 'number', 'date', 'time', 'select'];

const systemPrompt = z.string().max(4000, 'systemPrompt too long').optional();
const voice = z.enum(VOICES, { error: 'Invalid voice' }).optional();

const schemas = {
  signup: z.object({
    email,
    password,
    name: z.string().min(1, 'Name is required').max(80, 'Name too long').trim(),
  }),

  login: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),

  contactMessage: z.object({
    name: z.string().min(1, 'Name is required').max(120, 'Name too long').trim(),
    email,
    message: z.string().min(1, 'Message is required').max(5000, 'Message too long').trim(),
  }),

  forgotPassword: z.object({
    email,
  }),

  resetPassword: z.object({
    token: z.string().min(1, 'Reset token is required'),
    newPassword: password,
  }),

  verifyEmail: z.object({
    token: z.string().min(1, 'Verification token is required'),
  }),

  createProject: z.object({
    name: z.string().min(1, 'Name is required').max(120, 'Name too long').trim(),
    characterId: z.string().optional(),
    systemPrompt,
    voice,
    categoryId: z.string().optional(),
  }),

  categoryCreate: z.object({
    name: z.string().trim().min(1, 'name is required').max(80, 'name too long'),
    color: z.string().regex(HEX_COLOR_RE, 'color must be a 6-digit hex color').optional(),
    description: z.string().trim().max(300, 'description too long').optional(),
  }),

  categoryPatch: z.object({
    name: z.string().trim().min(1, 'name is required').max(80, 'name too long').optional(),
    color: z.string().regex(HEX_COLOR_RE, 'color must be a 6-digit hex color').nullable().optional(),
    description: z.string().trim().max(300, 'description too long').nullable().optional(),
  }).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' }),

  categoryAssignChatbots: z.object({
    projectIds: z.array(z.string().min(1)).min(1, 'projectIds is required').max(100, 'Max 100 chatbots per request'),
  }),

  inviteMember: z.object({
    email: z.string().trim().toLowerCase().email('A valid email is required'),
  }),

  // All fields optional — this backs a PATCH where any subset may be sent.
  // Cross-field checks that need DB state (characterId existence,
  // capabilityTier's plan_tiers lookup for a custom tier, webhookUrl's SSRF
  // safety check) stay in routes/projects.js after this runs.
  patchProject: z.object({
    name: z.string().min(1, 'Name is required').max(120, 'Name too long').trim().optional(),
    characterId: z.string().optional(),
    systemPrompt,
    voice,
    welcomeMessage: z.string().max(300, 'welcomeMessage too long').optional(),
    widgetPosition: z.enum(['bottom-right', 'bottom-left', 'inline'], { error: 'Invalid widgetPosition' }).optional(),
    widgetStartOpen: z.boolean().optional(),
    textDirection: z.enum(['auto', 'ltr', 'rtl'], { error: 'Invalid textDirection' }).optional(),
    themeColor: z.string().regex(HEX_COLOR_RE, 'themeColor must be a 6-digit hex color').optional(),
    widgetTheme: z.enum(['light', 'dark'], { error: 'Invalid widgetTheme' }).optional(),
    showBranding: z.boolean().optional(),
    showSourceCards: z.boolean().optional(),
    showQuickReplies: z.boolean().optional(),
    allowDragDropUpload: z.boolean().optional(),
    widgetOffsetX: z.number().int().min(0).max(100).optional(),
    widgetOffsetY: z.number().int().min(0).max(100).optional(),
    fullScreenOnDesktop: z.boolean().optional(),
    fullScreenOnMobile: z.boolean().optional(),
    showFullScreenToggle: z.boolean().optional(),
    showCharacterFullscreen: z.boolean().optional(),
    avatarPosition: z.enum(['left', 'right'], { error: 'Invalid avatarPosition' }).optional(),
    avatarSize: z.enum(['small', 'medium', 'large', 'xlarge'], { error: 'Invalid avatarSize' }).optional(),
    showAvatarInLauncher: z.boolean().optional(),
    avatarOffsetX: z.number().int().min(-100).max(100).optional(),
    avatarOffsetY: z.number().int().min(-100).max(100).optional(),
    avatarKeepVisible: z.boolean().optional(),
    avatarCompactOnMobile: z.boolean().optional(),
    // Format only — assertSafeUrl (SSRF: scheme + resolved-IP checks) still
    // runs in routes/projects.js before this is persisted.
    webhookUrl: z.string().url('Invalid webhookUrl').max(2048).nullable().optional(),
    capabilityTier: z.enum(CAPABILITY_TIERS, { error: 'Invalid capabilityTier' }).optional(),
    // Ownership check (does this category belong to req.user.id?) stays in
    // routes/projects.js, same as characterId above — null unassigns.
    categoryId: z.string().nullable().optional(),
    // Owner-editable overrides for widget copy that's otherwise hardcoded
    // English — see improvement-prompts.md Prompt F4 item 4. Both keys
    // optional/independent; an unset key falls back to the widget default.
    widgetMessages: z.object({
      inputPlaceholder: z.string().max(100, 'inputPlaceholder too long').optional(),
      limitReachedMessage: z.string().max(300, 'limitReachedMessage too long').optional(),
    }).optional(),
  }),

  filesInit: z.object({
    files: z.array(z.object({
      name: z.string().min(1, 'file name is required').max(255, 'file name too long'),
      size: z.number().nonnegative('file size must be a non-negative number').max(100 * 1024 * 1024, 'File too large (max 100MB)'),
      mimeType: z.string().max(255).optional(),
    })).min(1, 'No files requested').max(20, 'Max 20 files per request'),
  }),

  sourcesUrl: z.object({
    url: z.string().trim().min(1).optional(),
    urls: z.array(z.string()).max(20, 'Max 20 URLs per request').optional(),
  }).refine(d => (d.url && d.url.length > 0) || (d.urls && d.urls.length > 0), {
    message: 'Provide a URL (or urls: [...])',
  }),

  captureFieldCreate: z.object({
    label: z.string().trim().min(1, 'label is required').max(80, 'label too long'),
    key: z.string().trim().min(1, 'key is required').max(40, 'key must be 40 characters or fewer')
      .regex(/^[a-z][a-z0-9_]*$/, 'key must match /^[a-z][a-z0-9_]*$/'),
    type: z.enum(CAPTURE_FIELD_TYPES, { error: `type must be one of: ${CAPTURE_FIELD_TYPES.join(', ')}` }),
    options: z.array(z.string()).optional(),
    required: z.boolean().optional(),
    order: z.number().int().optional(),
  }).refine(d => d.type !== 'select' || (Array.isArray(d.options) && d.options.length > 0), {
    message: 'options array required for type=select',
    path: ['options'],
  }),

  captureFieldPatch: z.object({
    label: z.string().trim().min(1, 'label cannot be empty').max(80, 'label too long').optional(),
    type: z.enum(CAPTURE_FIELD_TYPES, { error: `type must be one of: ${CAPTURE_FIELD_TYPES.join(', ')}` }).optional(),
    options: z.array(z.string()).optional(),
    required: z.boolean().optional(),
    order: z.number().int().optional(),
  }),

  captureFieldReorder: z.object({
    ids: z.array(z.string(), { error: 'ids array required' }),
  }),

  createCheckoutSession: z.object({
    planId: z.string().min(1, 'planId is required'),
    couponCode: z.string().trim().min(1).max(40).optional(),
  }),

  validateCoupon: z.object({
    code: z.string().trim().min(1, 'code is required').max(40),
    planId: z.string().min(1, 'planId is required'),
  }),

  couponCreate: z.object({
    code: z.string().trim().toUpperCase().min(3, 'Code must be at least 3 characters').max(40, 'Code too long')
      .regex(/^[A-Z0-9_-]+$/, 'Code may contain only letters, numbers, hyphens, and underscores').optional(),
    discountType: z.enum(['percent', 'fixed'], { error: 'discountType must be percent or fixed' }),
    discountValue: z.number().positive('discountValue must be positive'),
    currency: z.string().trim().toLowerCase().length(3, 'currency must be a 3-letter code').optional(),
    applicablePlanIds: z.array(z.string()).optional(),
    maxRedemptions: z.number().int().positive().optional(),
    maxRedemptionsPerUser: z.number().int().positive().optional(),
    expiresAt: z.number().int().positive().optional(),
  })
    .refine(d => d.discountType !== 'percent' || d.discountValue <= 100, { message: 'Percent discount cannot exceed 100', path: ['discountValue'] })
    .refine(d => d.discountType !== 'fixed' || !!d.currency, { message: 'currency is required for a fixed discount', path: ['currency'] }),

  couponPatch: z.object({
    active: z.boolean().optional(),
    applicablePlanIds: z.array(z.string()).optional(),
    maxRedemptionsPerUser: z.number().int().positive().nullable().optional(),
  }).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' }),

  adminPatchUser: z.object({
    suspended: z.boolean().optional(),
    adminPlanId: z.string().nullable().optional(),
    // Only meaningful alongside a truthy adminPlanId — reason is an optional
    // free-text note for the audit trail, expiresAt (epoch ms) auto-reverts
    // the override once past, both ignored when clearing the override.
    reason: z.string().trim().max(500, 'reason too long').optional(),
    expiresAt: z.number().int().positive().nullable().optional(),
  }).refine(d => d.suspended !== undefined || d.adminPlanId !== undefined, {
    message: 'Nothing to update',
  }),

  // Empty string clears the override (falls back to .env) — see
  // services/settings.js setSetting.
  adminSettingUpdate: z.object({
    value: z.string().trim().max(500, 'value too long'),
  }),

  // Email templates (Prompt 5f) — subject/body only; see
  // services/emailTemplates.js. `body` is the HTML template, so no length
  // cap tight enough to matter here — generous ceiling just guards against
  // an accidental multi-MB paste.
  adminEmailTemplateUpdate: z.object({
    subject: z.string().trim().min(1, 'subject is required').max(500, 'subject too long'),
    body: z.string().min(1, 'body is required').max(50000, 'body too long'),
  }),

  // Feature-flag infra (admin-panel plan 5e) — flags are admin-defined, so
  // unlike adminSettingUpdate's fixed key list, key is part of the create
  // body and validated as an identifier here.
  featureFlagCreate: z.object({
    key: z.string().trim().min(1, 'key is required').max(80, 'key too long')
      .regex(/^[a-z][a-z0-9_]*$/, 'key must match /^[a-z][a-z0-9_]*$/'),
    description: z.string().trim().max(500, 'description too long').optional(),
  }),

  featureFlagUpdate: z.object({
    enabled: z.boolean({ error: 'enabled must be a boolean' }),
    description: z.string().trim().max(500, 'description too long').optional(),
  }),

  // Only a clear/moderation action today (Prompt 5c) — no admin full-replace
  // of widget copy, so `clear` must be explicitly true.
  adminClearWidgetMessages: z.object({
    clear: z.literal(true, { error: 'clear must be true' }),
  }),

  adminDeleteUser: z.object({
    confirmEmail: z.string().min(1, 'confirmEmail is required'),
  }),

  flashcardCreate: z.object({
    front: z.string().trim().min(1, 'front is required').max(2000, 'front too long'),
    back: z.string().trim().min(1, 'back is required').max(2000, 'back too long'),
    topicTag: z.string().trim().max(200, 'topicTag too long').optional(),
  }),

  quizQuestionCreate: z.object({
    question: z.string().trim().min(1, 'question is required').max(2000, 'question too long'),
    options: z.array(z.string().trim().min(1, 'options cannot be empty'))
      .min(2, 'options must be an array of 2 to 6 strings')
      .max(6, 'options must be an array of 2 to 6 strings'),
    correctIndex: z.number().int('correctIndex must be a valid index into options').nonnegative(),
    topicTag: z.string().trim().max(200, 'topicTag too long').optional(),
  }).refine(d => d.correctIndex < d.options.length, {
    message: 'correctIndex must be a valid index into options',
    path: ['correctIndex'],
  }),

  // PATCH allows a partial update; routes/quizQuestions.js merges with the
  // existing row and re-checks correctIndex against the merged options.
  quizQuestionPatch: z.object({
    question: z.string().trim().min(1, 'question is required').max(2000, 'question too long').optional(),
    options: z.array(z.string().trim().min(1, 'options cannot be empty'))
      .min(2, 'options must be an array of 2 to 6 strings')
      .max(6, 'options must be an array of 2 to 6 strings').optional(),
    correctIndex: z.number().int('correctIndex must be a valid index into options').nonnegative().optional(),
    topicTag: z.string().trim().max(200, 'topicTag too long').nullable().optional(),
  }),

  quizSuggestDistractors: z.object({
    question: z.string().trim().min(1, 'question is required').max(2000, 'question too long'),
    correctAnswer: z.string().trim().min(1, 'correctAnswer is required').max(500, 'correctAnswer too long'),
  }),

  videoResourceCreate: z.object({
    title: z.string().trim().min(1, 'title is required').max(200, 'title too long'),
    youtubeUrl: z.string().regex(YOUTUBE_URL_RE, 'youtubeUrl must be a valid youtube.com or youtu.be link'),
    topicTags: z.array(z.string().trim().min(1)).min(1, 'at least one topic tag is required'),
  }),

  embedLead: z.object({
    sessionId: z.string().min(1, 'sessionId required'),
    data: z.record(z.string(), z.unknown(), { error: 'data object required' }),
    complete: z.boolean().optional(),
  }),

  embedRetrieve: z.object({
    query: z.string().trim().min(1, 'Query required').max(2000, 'Query too long'),
    k: z.number().int().min(1).max(10).optional(),
  }),

  ask: z.object({
    question: z.string().min(1, 'question is required').max(1000, 'Question too long'),
    sessionId: z.string().optional().nullable(),
  }),

  study: z.object({
    message: z.string().min(1, 'message is required').max(1000, 'Message too long'),
    sessionId: z.string().optional().nullable(),
  }),

  quizAttempt: z.object({
    sessionId: z.string().min(1, 'sessionId is required'),
    question: z.string().min(1, 'question is required').max(2000),
    topic: z.string().max(200).optional(),
    selectedIndex: z.number().int().nullable().optional(),
    correctIndex: z.number().int(),
    sourceChunkIds: z.array(z.string()).optional(),
  }),

  flashcardReview: z.object({
    sessionId: z.string().min(1, 'sessionId is required'),
    front: z.string().min(1, 'front is required').max(2000),
    back: z.string().min(1, 'back is required').max(2000),
    topic: z.string().max(200).optional(),
    sourceChunkId: z.string().nullable().optional(),
    selfRating: z.enum(['got_it', 'still_learning'], { error: 'selfRating must be got_it or still_learning' }),
  }),

  log: z.object({
    role: z.enum(['user', 'assistant'], { error: 'role must be user or assistant' }),
    text: z.string().min(1, 'text is required').max(2000),
    sessionId: z.string().optional().nullable(),
  }),

  adminLogin: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),

  characterInit: z.object({
    name: z.string().trim().min(1, 'Name is required').max(80, 'Name too long'),
    description: z.string().trim().max(500, 'description too long').optional(),
    visibility: z.enum(['global', 'restricted'], { error: 'Invalid visibility' }).optional(),
  }),

  // inspectorMeta is admin-reported from the browser rive.js inspector —
  // advisory only (stored for display in the library), not re-validated
  // server-side, so this stays loose rather than pinning an exact shape.
  characterComplete: z.object({
    inspectorMeta: z.record(z.string(), z.unknown()).optional(),
  }),

  characterPatch: z.object({
    name: z.string().trim().min(1, 'Name is required').max(80, 'Name too long').optional(),
    description: z.string().trim().max(500, 'description too long').nullable().optional(),
    status: z.enum(['draft', 'active', 'archived'], { error: 'Invalid status' }).optional(),
    visibility: z.enum(['global', 'restricted'], { error: 'Invalid visibility' }).optional(),
  }).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' }),

  characterAccessGrant: z.object({
    userId: z.string().min(1, 'userId is required'),
  }),

  characterTriggerCreate: z.object({
    name: z.string().trim().min(1, 'Name is required').max(40, 'Name too long')
      .regex(/^[a-z0-9][a-z0-9 _-]*$/i, 'Use letters, numbers, spaces, - or _'),
    riveInput: z.string().trim().min(1, 'riveInput is required').max(80, 'riveInput too long'),
    inputType: z.enum(['trigger', 'boolean', 'number'], { error: 'inputType must be trigger, boolean, or number' }).optional(),
    activeValue: z.number().min(0).max(100).optional().nullable(),
    holdMs: z.number().int().min(100).max(10000).optional(),
    keywords: z.string().trim().max(500, 'keywords too long').optional().nullable(),
  }),

  characterTriggerPatch: z.object({
    name: z.string().trim().min(1, 'Name is required').max(40, 'Name too long')
      .regex(/^[a-z0-9][a-z0-9 _-]*$/i, 'Use letters, numbers, spaces, - or _').optional(),
    riveInput: z.string().trim().min(1, 'riveInput is required').max(80, 'riveInput too long').optional(),
    inputType: z.enum(['trigger', 'boolean', 'number'], { error: 'inputType must be trigger, boolean, or number' }).optional(),
    activeValue: z.number().min(0).max(100).optional().nullable(),
    holdMs: z.number().int().min(100).max(10000).optional(),
    keywords: z.string().trim().max(500, 'keywords too long').optional().nullable(),
  }).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' }),

  tierUpsert: z.object({
    name: z.string().trim().min(1, 'Name is required').max(80, 'Name too long'),
    limits: z.object({
      projects: z.number().int().positive(),
      maxFiles: z.number().int().positive(),
      storageMb: z.number().int().positive(),
      monthlyMessages: z.number().int().positive(),
      monthlyEmbeddingChars: z.number().int().positive(),
      urlSources: z.number().int().positive(),
    }).strict(),
  }),
};

module.exports = { validate, schemas, z };
