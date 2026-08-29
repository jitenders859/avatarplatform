/**
 * Shared analytics aggregates — conversion funnel + session duration.
 *
 * Extracted from the per-project queries added in commit bc3a765
 * (backend/routes/analytics.js `GET /project/:id`) so the same funnel-stage
 * SQL can be reused platform-wide by backend/routes/adminAnalytics.js
 * without copy-pasting it, per
 * docs/admin-panel-implementation-plan.md "3a. Aggregate analytics route"
 * (anti-pattern guard: do not duplicate the funnel-stage SQL).
 */
const db = require('../db');

// Conversion funnel: every session a visitor starts, how many actually sent
// a message (vs. opening the widget and leaving), how many of those left
// lead-capture info, and how many completed every capture field. Each stage
// is a strict subset of the one before it.
//
// Session duration = time between a session's first and last message. A
// single-message session has a duration of 0, which is correct (not missing
// data) — there's nothing to measure a span across yet.
//
// `projectId` scopes both queries to one project (the owner-facing route);
// pass nothing (or null) for a platform-wide rollup across every project
// (the admin overview route).
async function getFunnelAndDuration(projectId = null) {
  const params = projectId ? [projectId] : [];
  const scopeWhere = projectId ? 'WHERE project_id = $1' : '';
  const scopeAnd = projectId ? 'AND project_id = $1' : '';

  const [funnelRow, durationRow] = await Promise.all([
    db.queryOne(
      `SELECT
         (SELECT COUNT(*) FROM sessions ${scopeWhere})                            AS sessions,
         (SELECT COUNT(DISTINCT session_id) FROM messages ${scopeWhere})          AS engaged_sessions,
         (SELECT COUNT(DISTINCT session_id) FROM leads ${scopeWhere})             AS leads_captured,
         (SELECT COUNT(*) FROM leads WHERE complete = true ${scopeAnd})           AS leads_completed`,
      params
    ),
    db.queryOne(
      `SELECT COALESCE(AVG(span_ms), 0) AS avg_ms
       FROM (
         SELECT session_id, MAX(created_at) - MIN(created_at) AS span_ms
         FROM messages ${scopeWhere} GROUP BY session_id
       ) sub`,
      params
    ),
  ]);

  return {
    funnel: {
      sessions:        Number(funnelRow.sessions),
      engagedSessions: Number(funnelRow.engagedSessions),
      leadsCaptured:   Number(funnelRow.leadsCaptured),
      leadsCompleted:  Number(funnelRow.leadsCompleted),
    },
    avgSessionDurationSec: Math.round((Number(durationRow.avgMs) || 0) / 1000),
  };
}

module.exports = { getFunnelAndDuration };
