const express = require('express');
const crypto = require('crypto');
const uuid = crypto.randomUUID;
const db = require('../db');
const { authRequired, optionalAuth } = require('../middleware/auth');
const { invalidateProjectCache } = require('../cache');
const { safeFetch, assertSafeUrl } = require('../services/safeFetch');
const { validate, schemas } = require('../middleware/validate');
const storage = require('../services/storage');

const router = express.Router();

// Which env var backs each TTS-only voice engine — checked at PATCH time so
// an owner switching engines gets a clear error immediately instead of a
// silently broken widget once a visitor tries to speak to it.
const VOICE_ENGINE_ENV_KEY = {
  'fish-audio': 'FISH_AUDIO_API_KEY',
  cartesia: 'CARTESIA_API_KEY',
};

// Characters assignable to a project: admin-published (status='active') and
// either globally available or explicitly granted to this user. Ordered
// oldest-first so the pre-migration default (the original "character_1"/
// Aria) stays first — used as the fallback default below, same as before
// this became DB-driven. Anonymous callers (userId undefined) only ever see
// global characters, since character_access.user_id can never match NULL.
async function listAvailableCharacters(userId) {
  const rows = await db.query(
    `SELECT c.* FROM characters c
      WHERE c.status = 'active'
        AND (c.visibility = 'global' OR EXISTS (
          SELECT 1 FROM character_access ca WHERE ca.character_id = c.id AND ca.user_id = $1
        ))
      ORDER BY c.created_at ASC`,
    [userId || null]
  );
  return rows.map(toCharacterDTO);
}

function toCharacterDTO(c) {
  return { id: c.slug, name: c.name, description: c.description, rivePath: storage.characterAssets.getPublicUrl(c.storageKey) };
}

// GET /projects/characters is hit anonymously by the public marketing
// character-picker page (public/characters.html) as well as by logged-in
// users choosing a character for a new/existing project — optionalAuth
// personalizes restricted-visibility results for the latter without
// requiring login for the former.
router.get('/characters', optionalAuth, async (req, res) => {
  res.json({ characters: await listAvailableCharacters(req.user?.id) });
});

router.get('/', authRequired, async (req, res) => {
  const projects = await db.findAll('projects', { userId: req.user.id }, { orderBy: 'createdAt', order: 'desc' });
  res.json({ projects: projects.map(strip) });
});

router.post('/', authRequired, validate(schemas.createProject), async (req, res) => {
  const { name, characterId, systemPrompt, voice, voiceEngine } = req.body;

  const { checkLimit } = require('../services/usage');
  const limitCheck = await checkLimit(req.user.id, 'project', 1);
  if (!limitCheck.ok) return res.status(402).json({ error: limitCheck.reason, limit: limitCheck });

  const available = await listAvailableCharacters(req.user.id);
  const ch = available.find(c => c.id === characterId) || available[0];
  if (!ch) return res.status(500).json({ error: 'No characters are currently available' });
  const project = await db.insert('projects', {
    id: uuid(),
    userId: req.user.id,
    name: name.trim(),
    characterId: ch.id,
    systemPrompt: systemPrompt || 'You are a friendly, helpful AI assistant. Speak naturally and conversationally.',
    voiceEngine: voiceEngine || 'gemini-live',
    voice: voice || 'Puck',
    welcomeMessage: 'Hi! Ask me anything.',
    publicId: uuid().replace(/-/g, '').slice(0, 16),
    capabilityTier: 'basic',
    // Widget customization
    widgetPosition: 'bottom-right',
    widgetStartOpen: false,
    textDirection: 'auto',
    themeColor: '#7c6af5',
    widgetTheme: 'light',
    showBranding: true,
    showSourceCards: true,
    showQuickReplies: false,
    allowDragDropUpload: false,
    fullScreenOnDesktop: false,
    fullScreenOnMobile: false,
    showFullScreenToggle: false,
    widgetOffsetX: 0,
    widgetOffsetY: 0,
    // Avatar placement
    avatarPosition: 'right',
    avatarSize: 'large',
    showAvatarInLauncher: true,
    avatarOffsetX: 0,
    avatarOffsetY: 0,
    avatarKeepVisible: true,
    avatarCompactOnMobile: true,
    // Webhook
    webhookUrl: null,
    webhookSecret: crypto.randomBytes(32).toString('hex'),
    createdAt: Date.now(),
  });
  res.json({ project: strip(project) });
});

router.get('/:id', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: strip(project) });
});

router.patch('/:id', authRequired, validate(schemas.patchProject), async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // req.body is already stripped to only the ~28 allowlisted keys (whatever
  // subset the caller sent) by the patchProject schema — everything else
  // was type/enum/format-checked there. What's left are the checks that
  // need DB state or the SSRF-safety network check, which can't live in a
  // synchronous schema.
  const patch = req.body;

  if (patch.characterId) {
    const available = await listAvailableCharacters(req.user.id);
    if (!available.find(c => c.id === patch.characterId)) {
      return res.status(400).json({ error: 'Unknown character' });
    }
  }
  if (patch.voiceEngine) {
    const envKey = VOICE_ENGINE_ENV_KEY[patch.voiceEngine];
    if (envKey && !process.env[envKey]) {
      return res.status(400).json({ error: `This server isn't configured for ${patch.voiceEngine} yet (missing ${envKey}).` });
    }
  }
  if (patch.webhookUrl) {
    try {
      await assertSafeUrl(patch.webhookUrl);
    } catch (e) {
      return res.status(400).json({ error: `Invalid webhookUrl: ${e.message}` });
    }
  }

  const updated = await db.update('projects', project.id, patch);
  invalidateProjectCache(project.publicId);
  res.json({ project: strip(updated) });
});

router.delete('/:id', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  // FK CASCADE handles files, chunks, sessions, messages, capture_fields, leads
  await db.remove('projects', { id: project.id });
  invalidateProjectCache(project.publicId);
  res.json({ ok: true });
});

router.get('/:id/sessions', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Use SQL to avoid N+1 message-count queries
  const sessions = await db.query(
    `SELECT s.id, s.created_at, COUNT(m.id) AS message_count
     FROM sessions s
     LEFT JOIN messages m ON m.session_id = s.id
     WHERE s.project_id = $1
     GROUP BY s.id, s.created_at
     ORDER BY s.created_at DESC`,
    [project.id]
  );
  res.json({
    sessions: sessions.map(s => ({
      id: s.id,
      createdAt: s.createdAt,
      messageCount: Number(s.messageCount),
    })),
  });
});

router.get('/:id/sessions/:sessionId', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const session = await db.findOne('sessions', { id: req.params.sessionId, projectId: project.id });
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const messages = await db.findAll('messages', { sessionId: session.id }, { orderBy: 'createdAt', order: 'asc' });
  res.json({
    session: { id: session.id, createdAt: session.createdAt },
    messages: messages.map(m => ({ id: m.id, role: m.role, content: m.text, createdAt: m.createdAt })),
  });
});

router.get('/:id/leads', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { complete = 'all', page = 1, limit = 50 } = req.query;
  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const offset   = (pageNum - 1) * pageSize;

  const fields = await db.findAll('captureFields', { projectId: project.id });
  const fieldMap = Object.fromEntries(fields.map(f => [f.key, f.label]));

  // Build WHERE clause for complete filter
  let completeClause = '';
  if (complete === 'true')  completeClause = 'AND l.complete = true';
  if (complete === 'false') completeClause = 'AND l.complete = false';

  const [totalRow, leads] = await Promise.all([
    db.queryOne(
      `SELECT COUNT(*) AS total FROM leads WHERE project_id = $1 ${completeClause}`,
      [project.id]
    ),
    db.query(
      `SELECT l.*, s.created_at AS session_created_at
       FROM leads l
       LEFT JOIN sessions s ON s.id = l.session_id
       WHERE l.project_id = $1 ${completeClause}
       ORDER BY l.created_at DESC
       LIMIT $2 OFFSET $3`,
      [project.id, pageSize, offset]
    ),
  ]);

  const enriched = leads.map(l => ({ ...l, fieldLabels: fieldMap }));
  res.json({ leads: enriched, total: Number(totalRow.total), page: pageNum, limit: pageSize });
});

router.get('/:id/leads/:leadId', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const lead = await db.findOne('leads', { id: req.params.leadId, projectId: project.id });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const fields = await db.findAll('captureFields', { projectId: project.id });
  const fieldMap = Object.fromEntries(fields.map(f => [f.key, f.label]));

  const session = await db.findOne('sessions', { id: lead.sessionId });
  const messages = session
    ? (await db.findAll('messages', { sessionId: session.id }, { orderBy: 'createdAt', order: 'asc' }))
        .map(m => ({ id: m.id, role: m.role, content: m.text, createdAt: m.createdAt }))
    : [];

  res.json({ lead: { ...lead, fieldLabels: fieldMap }, messages });
});

router.post('/:id/webhook/test', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.webhookUrl) return res.status(400).json({ error: 'No webhook URL configured' });

  const payload = JSON.stringify({
    event: 'test',
    publicId: project.publicId,
    sessionId: 'test-session',
    role: 'user',
    text: 'This is a test message from AvatarPlatform.',
    timestamp: Date.now(),
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', project.webhookSecret || '').update(payload).digest('hex');

  try {
    const response = await safeFetch(project.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Avatar-Signature': sig },
      body: payload,
      timeout: 5000,
    });
    res.json({ ok: response.ok, status: response.status, statusText: response.statusText });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/:id/duplicate', authRequired, async (req, res) => {
  const source = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!source) return res.status(404).json({ error: 'Project not found' });

  const { checkLimit } = require('../services/usage');
  const limitCheck = await checkLimit(req.user.id, 'project', 1);
  if (!limitCheck.ok) return res.status(402).json({ error: limitCheck.reason, limit: limitCheck });

  const { id: _id, publicId: _pid, createdAt: _ca, updatedAt: _ua, ...rest } = source;
  const project = await db.insert('projects', {
    ...rest,
    id: uuid(),
    publicId: uuid().replace(/-/g, '').slice(0, 16),
    name: source.name + ' (copy)',
    webhookUrl: null,
    webhookSecret: crypto.randomBytes(32).toString('hex'),
    createdAt: Date.now(),
  });
  res.json({ project: strip(project) });
});

function strip(p) {
  if (!p) return p;
  const { ...rest } = p;
  return rest;
}

module.exports = { router };
