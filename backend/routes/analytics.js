/**
 * Analytics — read-only aggregations over the messages and files tables.
 *
 * Pretty lightweight; computes everything on demand. For larger scale,
 * cache per-period aggregates and recompute hourly.
 */
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

router.get('/overview', authRequired, (req, res) => {
  const userId = req.user.id;
  const projects = db.findAll('projects', p => p.userId === userId);
  const projectIds = new Set(projects.map(p => p.id));

  const messages = db.findAll('messages', m => projectIds.has(m.projectId));
  const sessions = db.findAll('sessions', s => projectIds.has(s.projectId));
  const files    = db.findAll('files',    f => f.userId === userId);
  const leads    = db.findAll('leads',    l => projectIds.has(l.projectId));

  // Last 30 days, bucketed by day
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const buckets = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now - i * DAY);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    buckets.push({ date: key, messages: 0, sessions: 0 });
  }
  const indexByDate = Object.fromEntries(buckets.map((b, i) => [b.date, i]));

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  for (const m of messages) {
    const k = dayKey(m.createdAt);
    if (k in indexByDate) buckets[indexByDate[k]].messages += 1;
  }
  for (const s of sessions) {
    const k = dayKey(s.createdAt);
    if (k in indexByDate) buckets[indexByDate[k]].sessions += 1;
  }

  // Per-project rollup
  const byProject = {};
  for (const p of projects) {
    byProject[p.id] = { id: p.id, name: p.name, messages: 0, sessions: 0, files: 0, leads: 0 };
  }
  for (const m of messages) if (byProject[m.projectId]) byProject[m.projectId].messages += 1;
  for (const s of sessions) if (byProject[s.projectId]) byProject[s.projectId].sessions += 1;
  for (const f of files)    if (byProject[f.projectId]) byProject[f.projectId].files    += 1;
  for (const l of leads)    if (byProject[l.projectId]) byProject[l.projectId].leads    += 1;

  res.json({
    totals: {
      projects: projects.length,
      files: files.length,
      messages: messages.length,
      sessions: sessions.length,
      leads: leads.length,
    },
    daily: buckets,
    byProject: Object.values(byProject).sort((a, b) => b.messages - a.messages),
  });
});

router.get('/project/:id', authRequired, (req, res) => {
  const project = db.findOne('projects', p => p.id === req.params.id && p.userId === req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const messages = db.findAll('messages', m => m.projectId === project.id);
  const sessions = db.findAll('sessions', s => s.projectId === project.id);
  const files    = db.findAll('files',    f => f.projectId === project.id);

  // 30-day daily buckets
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const buckets = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now - i * DAY);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    buckets.push({ date: key, messages: 0, sessions: 0 });
  }
  const indexByDate = Object.fromEntries(buckets.map((b, i) => [b.date, i]));
  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  for (const m of messages) { const k = dayKey(m.createdAt); if (k in indexByDate) buckets[indexByDate[k]].messages += 1; }
  for (const s of sessions) { const k = dayKey(s.createdAt); if (k in indexByDate) buckets[indexByDate[k]].sessions += 1; }

  // Per-session message counts for avg calculation
  const sessionMsgCounts = sessions.map(s => db.findAll('messages', m => m.sessionId === s.id).length);
  const avgSessionLength = sessionMsgCounts.length
    ? Math.round(sessionMsgCounts.reduce((a, b) => a + b, 0) / sessionMsgCounts.length)
    : 0;

  // 10 most recent unique user messages
  const userMessages = messages.filter(m => m.role === 'user').sort((a, b) => b.createdAt - a.createdAt);
  const seen = new Set();
  const topQuestions = [];
  for (const m of userMessages) {
    const key = (m.text || '').trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      topQuestions.push({ text: m.text, createdAt: m.createdAt });
      if (topQuestions.length >= 10) break;
    }
  }

  const leads = db.findAll('leads', l => l.projectId === project.id);

  res.json({
    totals: {
      sessions: sessions.length,
      messages: messages.length,
      files: files.length,
      avgSessionLength,
      leads: leads.length,
      leadsComplete: leads.filter(l => l.complete).length,
    },
    daily: buckets,
    topQuestions,
  });
});

module.exports = router;
