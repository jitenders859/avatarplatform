const express = require('express');
const crypto = require('crypto');
const uuid = crypto.randomUUID;
const db = require('../db');
const { authRequired, optionalAuth } = require('../middleware/auth');
const { invalidateProjectCache } = require('../cache');
const { safeFetch, assertSafeUrl } = require('../services/safeFetch');
const { validate, schemas } = require('../middleware/validate');
const { userPlanId } = require('../services/usage');
const { sendTeamInviteEmail } = require('../services/email');
const storage = require('../services/storage');

const router = express.Router();

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

// leadCount folded in here (one grouped query) rather than the dashboard
// firing one GET /:id/leads?limit=1 per project just to read its total —
// see improvement-prompts.md Prompt P1-1 item 4.
router.get('/', authRequired, async (req, res) => {
  const projects = await db.query(
    `SELECT p.*, COUNT(l.id)::int AS lead_count
       FROM projects p
       LEFT JOIN leads l ON l.project_id = p.id
      WHERE p.user_id = $1
      GROUP BY p.id
      ORDER BY p.created_at DESC`,
    [req.user.id]
  );
  res.json({ projects });
});

// Email-verification soft gate — time-based rather than an outright block
// on unverified accounts, so a new signup can still create their first
// chatbot immediately (blocking that would cost more signups than an
// unverified email costs in abuse risk). After the grace window, an
// unverified account can't create MORE projects until they verify.
const VERIFY_GRACE_MS = 72 * 3600000;

router.post('/', authRequired, validate(schemas.createProject), async (req, res) => {
  if (!req.user.emailVerifiedAt && Date.now() - req.user.createdAt > VERIFY_GRACE_MS) {
    return res.status(403).json({
      error: 'Please verify your email to create more chatbots.',
      code: 'EMAIL_NOT_VERIFIED',
    });
  }

  const { name, characterId, systemPrompt, voice } = req.body;

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
  res.json({ project });
});

// Team members (project_members) get read-only access to a project's
// Conversations + Analytics data — see improvement-prompts.md Prompt F4
// item 3. Deliberately scoped narrow (read-only, two tabs) rather than
// full co-editing, so this is the only place that needs to know about
// membership: everything else (settings, knowledge, leads, billing-ish
// actions) stays owner-only via the existing `userId: req.user.id` filter.
async function findProjectForRead(id, userId) {
  const owned = await db.findOne('projects', { id, userId });
  if (owned) return { project: owned, isOwner: true };
  const project = await db.findOne('projects', { id });
  if (!project) return null;
  const member = await db.findOne('projectMembers', { projectId: id, userId });
  if (!member) return null;
  return { project, isOwner: false };
}

router.get('/:id', authRequired, async (req, res) => {
  const result = await findProjectForRead(req.params.id, req.user.id);
  if (!result) return res.status(404).json({ error: 'Project not found' });
  if (result.isOwner) return res.json({ project: result.project, isOwner: true });
  // Members never see the webhook secret — they can't manage the webhook,
  // so there's no reason for it to leave the server for their session.
  const { webhookSecret: _ws, ...readOnlyProject } = result.project;
  res.json({ project: readOnlyProject, isOwner: false });
});

router.get('/:id/members', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const members = await db.query(
    `SELECT pm.id, pm.user_id, pm.created_at, u.email, u.name
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1
      ORDER BY pm.created_at ASC`,
    [project.id]
  );
  res.json({ members });
});

// Team members are a Business-plan feature (see plans.js) — the invite
// itself is gated here rather than hiding the whole endpoint, so an
// existing member list still loads (and can be pruned) if an owner
// downgrades off Business.
router.post('/:id/members', authRequired, validate(schemas.inviteMember), async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const planId = await userPlanId(req.user.id);
  if (planId !== 'business') {
    return res.status(403).json({ error: 'Team members require the Business plan.', code: 'BUSINESS_PLAN_REQUIRED' });
  }

  const { email } = req.body;
  const invitee = await db.findOne('users', { email });
  if (!invitee) {
    return res.status(404).json({ error: "No AvatarPlatform account found for that email — ask them to sign up first, then invite them." });
  }
  if (invitee.id === req.user.id) {
    return res.status(400).json({ error: "You can't invite yourself." });
  }

  const existing = await db.findOne('projectMembers', { projectId: project.id, userId: invitee.id });
  if (existing) return res.status(409).json({ error: 'Already a member of this chatbot.' });

  const member = await db.insert('projectMembers', {
    id: uuid(),
    projectId: project.id,
    userId: invitee.id,
    invitedBy: req.user.id,
    createdAt: Date.now(),
  });
  setImmediate(() => sendTeamInviteEmail(invitee.email, project.name, req.user.email).catch(() => {}));
  res.json({ member: { ...member, email: invitee.email, name: invitee.name } });
});

router.delete('/:id/members/:memberId', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const removed = await db.remove('projectMembers', { id: req.params.memberId, projectId: project.id });
  if (!removed) return res.status(404).json({ error: 'Member not found' });
  res.json({ ok: true });
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
  if (patch.webhookUrl) {
    try {
      await assertSafeUrl(patch.webhookUrl);
    } catch (e) {
      return res.status(400).json({ error: `Invalid webhookUrl: ${e.message}` });
    }
  }

  const updated = await db.update('projects', project.id, patch);
  invalidateProjectCache(project.publicId);
  res.json({ project: updated });
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
  const result = await findProjectForRead(req.params.id, req.user.id);
  if (!result) return res.status(404).json({ error: 'Project not found' });
  const { project } = result;

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
  const result = await findProjectForRead(req.params.id, req.user.id);
  if (!result) return res.status(404).json({ error: 'Project not found' });
  const { project } = result;

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
  const fieldMap = { name: 'Name', email: 'Email', ...Object.fromEntries(fields.map(f => [f.key, f.label])) };

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
  const fieldMap = { name: 'Name', email: 'Email', ...Object.fromEntries(fields.map(f => [f.key, f.label])) };

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

// Recent attempts logged by services/webhookDelivery.js — see
// improvement-prompts.md Prompt F4 item 6. Most-recent-first, capped so a
// chatty webhook (one row per user message) can't return an unbounded page.
router.get('/:id/webhook/deliveries', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const deliveries = await db.query(
    `SELECT id, event_type, status, attempt, response_status, error, created_at, delivered_at
       FROM webhook_deliveries
      WHERE project_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [project.id]
  );
  res.json({ deliveries });
});

// Rotating invalidates the old secret immediately — any in-flight
// signature verification on the receiving end using the old value will
// fail until the owner updates it there too. Deliberately synchronous
// (not soft-expired) since there's no way to signal "old secret still
// valid for N minutes" to a receiver that doesn't know this API.
router.post('/:id/webhook/rotate-secret', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const updated = await db.update('projects', project.id, { webhookSecret });
  invalidateProjectCache(project.publicId);
  res.json({ webhookSecret: updated.webhookSecret });
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
  res.json({ project });
});

// Project GETs return the full row, webhookSecret included — the owner
// needs it to verify webhook signatures in their own receiving endpoint
// (see project.html's Webhook settings, which displays it), so it's
// intentionally not stripped.
module.exports = { router };
