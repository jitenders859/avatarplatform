const express = require('express');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

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

router.get('/', authRequired, (req, res) => {
  const projects = db.findAll('projects', p => p.userId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  // Hide internal fields
  res.json({ projects: projects.map(strip) });
});

router.post('/', authRequired, async (req, res) => {
  const { name, characterId, systemPrompt, voice } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  // Plan-limit check
  const { checkLimit } = require('../services/usage');
  const limitCheck = checkLimit(req.user.id, 'project', 1);
  if (!limitCheck.ok) return res.status(402).json({ error: limitCheck.reason, limit: limitCheck });

  const ch = CHARACTERS.find(c => c.id === characterId) || CHARACTERS[0];
  const project = {
    id: uuid(),
    userId: req.user.id,
    name: name.trim(),
    characterId: ch.id,
    systemPrompt: systemPrompt || 'You are a friendly, helpful AI assistant. Speak naturally and conversationally.',
    voice: voice || 'Puck',
    welcomeMessage: 'Hi! Ask me anything.',
    publicId: uuid().replace(/-/g, '').slice(0, 16), // shorter ID for embed URLs

    // Widget customization (defaults)
    widgetPosition: 'bottom-right',         // bottom-right | bottom-left | inline
    widgetStartOpen: false,                 // start minimized by default
    textDirection: 'auto',                  // auto | ltr | rtl
    themeColor: '#7c6af5',
    showBranding: true,
    showSourceCards: true,
    widgetOffsetX: 0,
    widgetOffsetY: 0,

    // Webhook
    webhookUrl: null,
    webhookSecret: crypto.randomBytes(32).toString('hex'),

    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.insert('projects', project);
  res.json({ project: strip(project) });
});

router.get('/:id', authRequired, (req, res) => {
  const project = db.findOne('projects', p => p.id === req.params.id && p.userId === req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: strip(project) });
});

router.patch('/:id', authRequired, async (req, res) => {
  const project = db.findOne('projects', p => p.id === req.params.id && p.userId === req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const allowed = [
    'name', 'characterId', 'systemPrompt', 'voice', 'welcomeMessage',
    'widgetPosition', 'widgetStartOpen', 'textDirection', 'themeColor',
    'showBranding', 'showSourceCards', 'widgetOffsetX', 'widgetOffsetY',
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

  const updated = await db.update('projects', project.id, patch);
  res.json({ project: strip(updated) });
});

router.delete('/:id', authRequired, async (req, res) => {
  const project = db.findOne('projects', p => p.id === req.params.id && p.userId === req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Cascade: remove project's files, chunks, sessions, messages, capture data
  await db.remove('projects',      p => p.id === project.id);
  await db.remove('files',         f => f.projectId === project.id);
  await db.remove('chunks',        c => c.projectId === project.id);
  await db.remove('sessions',      s => s.projectId === project.id);
  await db.remove('messages',      m => m.projectId === project.id);
  await db.remove('captureFields', f => f.projectId === project.id);
  await db.remove('leads',         l => l.projectId === project.id);
  // Note: actual file blobs on disk are intentionally left for the operator
  // to clean up via a separate task — keeps the request fast.
  res.json({ ok: true });
});

router.get('/:id/sessions', authRequired, (req, res) => {
  const project = db.findOne('projects', p => p.id === req.params.id && p.userId === req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const sessions = db.findAll('sessions', s => s.projectId === project.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(s => ({
      id: s.id,
      createdAt: s.createdAt,
      messageCount: db.findAll('messages', m => m.sessionId === s.id).length,
    }));

  res.json({ sessions });
});

router.get('/:id/sessions/:sessionId', authRequired, (req, res) => {
  const project = db.findOne('projects', p => p.id === req.params.id && p.userId === req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const session = db.findOne('sessions', s => s.id === req.params.sessionId && s.projectId === project.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const messages = db.findAll('messages', m => m.sessionId === session.id)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(m => ({ id: m.id, role: m.role, content: m.text, createdAt: m.createdAt }));

  res.json({ session: { id: session.id, createdAt: session.createdAt }, messages });
});

router.get('/:id/leads', authRequired, (req, res) => {
  const project = db.findOne('projects', p => p.id === req.params.id && p.userId === req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { complete = 'all', page = 1, limit = 50 } = req.query;
  const fields = db.findAll('captureFields', f => f.projectId === project.id);
  const fieldMap = Object.fromEntries(fields.map(f => [f.key, f.label]));

  let leads = db.findAll('leads', l => l.projectId === project.id)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (complete === 'true')  leads = leads.filter(l => l.complete);
  if (complete === 'false') leads = leads.filter(l => !l.complete);

  const total = leads.length;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(limit) || 50));
  leads = leads.slice((pageNum - 1) * pageSize, pageNum * pageSize);

  const enriched = leads.map(l => {
    const session = db.findOne('sessions', s => s.id === l.sessionId);
    return {
      ...l,
      sessionCreatedAt: session ? session.createdAt : null,
      fieldLabels: fieldMap,
    };
  });

  res.json({ leads: enriched, total, page: pageNum, limit: pageSize });
});

router.get('/:id/leads/:leadId', authRequired, (req, res) => {
  const project = db.findOne('projects', p => p.id === req.params.id && p.userId === req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const lead = db.findOne('leads', l => l.id === req.params.leadId && l.projectId === project.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const fields = db.findAll('captureFields', f => f.projectId === project.id);
  const fieldMap = Object.fromEntries(fields.map(f => [f.key, f.label]));

  const session = db.findOne('sessions', s => s.id === lead.sessionId);
  const messages = session
    ? db.findAll('messages', m => m.sessionId === session.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(m => ({ id: m.id, role: m.role, content: m.text, createdAt: m.createdAt }))
    : [];

  res.json({ lead: { ...lead, fieldLabels: fieldMap }, messages });
});

router.post('/:id/webhook/test', authRequired, async (req, res) => {
  const project = db.findOne('projects', p => p.id === req.params.id && p.userId === req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.webhookUrl) return res.status(400).json({ error: 'No webhook URL configured' });

  const payload = {
    event: 'test',
    publicId: project.publicId,
    sessionId: 'test-session',
    role: 'user',
    text: 'This is a test message from AvatarPlatform.',
    timestamp: Date.now(),
  };
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', project.webhookSecret || '').update(body).digest('hex');

  try {
    const fetch = require('node-fetch');
    const response = await fetch(project.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Avatar-Signature': sig },
      body,
      timeout: 5000,
    });
    res.json({ ok: response.ok, status: response.status, statusText: response.statusText });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/:id/duplicate', authRequired, async (req, res) => {
  const source = db.findOne('projects', p => p.id === req.params.id && p.userId === req.user.id);
  if (!source) return res.status(404).json({ error: 'Project not found' });

  const { checkLimit } = require('../services/usage');
  const limitCheck = checkLimit(req.user.id, 'project', 1);
  if (!limitCheck.ok) return res.status(402).json({ error: limitCheck.reason, limit: limitCheck });

  const project = {
    ...source,
    id: uuid(),
    publicId: uuid().replace(/-/g, '').slice(0, 16),
    name: source.name + ' (copy)',
    webhookUrl: null,
    webhookSecret: crypto.randomBytes(32).toString('hex'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.insert('projects', project);
  res.json({ project: strip(project) });
});

function strip(p) {
  if (!p) return p;
  const { ...rest } = p;
  return rest;
}

module.exports = { router, CHARACTERS };
