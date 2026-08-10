const crypto = require('crypto');
const db = require('../db');

// Both targetUserId and targetEmail are stored: target_user_id is set to
// NULL via ON DELETE SET NULL when the user is deleted, so target_email
// keeps the audit row self-describing after the account is gone.
async function logAdminAction({ adminId, action, targetUserId = null, targetEmail = null, meta = {} }) {
  await db.insert('admin_audit_log', {
    id: crypto.randomUUID(),
    adminId,
    action,
    targetUserId,
    targetEmail,
    meta,
    createdAt: Date.now(),
  });
}

module.exports = { logAdminAction };
