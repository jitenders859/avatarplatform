const express = require('express');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { invalidateProjectCache } = require('../cache');

const router = express.Router();

const CHARACTERS = [
  { id: 'character_1', name: 'Aria',   description: 'Friendly, expressive default character',  rivePath: '/assets/characters/character_1.riv' },
  { id: 'character_2', name: 'Kai',    description: 'Calm, professional support agent vibe',   rivePath: '/assets/characters/character_2.riv' },
  { id: 'character_3', name: 'Nova',   description: 'Energetic, upbeat brand ambassador',      rivePath: '/assets/characters/character_3.riv' },
  { id: 'character_4', name: 'Echo',   description: 'Soft-spoken, thoughtful guide',           rivePath: '/assets/characters/character_4.riv' },
];

router.get('/characters', (req, res) => {
  res.json({ characters: CHARACTERS });
});

router.get('/', authRequired, async (req, res) => {
  const projects = await db.findAll('projects', { userId: req.user.id }, { orderBy: 'createdAt', order: 'desc' });
  res.json({ projects: projects.map(strip) });
});

router.post('/', authRequired, async (req, res) => {
  const { name, characterId, systemPrompt, voice } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const { checkLimit } = require('../services/usage');
  const limitCheck = await checkLimit(req.user.id, 'project', 1);
  if (!limitCheck.ok) return res.status(402).json({ error: limitCheck.reason, limit: limitCheck });

  const ch = CHARACTERS.find(c => c.id === characterId) || CHARACTERS[0];
  const project = await db.insert('projects', {
    id: uuid(),
    userId: req.user.id,
    name: name.trim(),
    characterId: ch.id,
    systemPrompt: systemPrompt || 'You are a friendly, helpful AI assistant. Speak naturally and conversationally.',
    voice: voice || 'Puck',
    welcomeMessage: 'Hi! Ask me anything.',
    publicId: uuid().replace(/-/g, '').slice(0, 16),
    // Widget customization
    widgetPosition: 'bottom-right',
    widgetStartOpen: false,
    textDirection: 'auto',
    themeColor: '#7c6af5',
    showBranding: true,
    showSourceCards: true,
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

router.patch('/:id', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const allowed = [
    'name', 'characterId', 'systemPrompt', 'voice', 'welcomeMessage',
    'widgetPosition', 'widgetStartOpen', 'textDirection', 'themeColor',
    'showBranding', 'showSourceCards', 'widgetOffsetX', 'widgetOffsetY',
    'avatarPosition', 'avatarSize', 'showAvatarInLauncher',
    'avatarOffsetX', 'avatarOffsetY', 'avatarKeepVisible', 'avatarCompactOnMobile',
    'webhookUrl',
  ];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];

  if (patch.characterId && !CHARACTERS.find(c => c.id === patch.characterId)) {
    return res.status(400).json({ error: 'Unknown character' });
  }
  if (patch.widgetPosition && !['bottom-right', 'bottom-left', 'inline'].includes(patch.widgetPosition)) {
    return res.status(400).json({ error: 'Invalid widgetPosition' });
  }
  if (patch.textDirection && !['auto', 'ltr', 'rtl'].includes(patch.textDirection)) {
    return res.status(400).json({ error: 'Invalid textDirection' });
  }
  if (patch.avatarPosition && !['left', 'right'].includes(patch.avatarPosition)) {
    return res.status(400).json({ error: 'Invalid avatarPosition' });
  }
  if (patch.avatarSize && !['small', 'medium', 'large', 'xlarge'].includes(patch.avatarSize)) {
    return res.status(400).json({ error: 'Invalid avatarSize' });
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
    const fetch = require('node-fetch');
    const response = await fetch(project.webhookUrl, {
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

module.exports = { router, CHARACTERS };
