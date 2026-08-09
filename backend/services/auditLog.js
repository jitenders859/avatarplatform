const crypto = require('crypto');
const db = require('../db');

async function logAdminAction(adminId, action, targetUserId, targetEmail, meta = {}) {
  await db.insert('admin_audit_log', {
    id: crypto.randomUUID(),
    adminId,
    action,
    targetUserId: targetUserId || null,
    targetEmail: targetEmail || null,
    meta,
    createdAt: Date.now(),
  });
}

module.exports = { logAdminAction };
