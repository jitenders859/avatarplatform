/**
 * Notifies a project's owner when something happens on their chatbot that
 * they'd want to act on quickly: a visitor completes a lead-capture form,
 * or books a tour. Email always fires (best-effort — see services/email.js's
 * no-op-when-unconfigured behavior); SMS only fires if the owner has opted
 * in and has a phone on file, same opt-in column services/usage.js's usage
 * alert sweep already uses (users.phone / users.sms_alerts_enabled).
 *
 * Called fire-and-forget via setImmediate from the request/tool-call path
 * that just wrote the lead/booking, mirroring services/webhookDelivery.js's
 * queueWebhookDelivery call sites — a slow or failing send must never delay
 * the visitor-facing response.
 */
const db = require('../db');
const { sendLeadNotification, sendTourBookedNotification } = require('./email');
const { sendSms } = require('./sms');
const logger = require('../logger').child({ module: 'services/ownerAlerts' });

const APP_URL = () => process.env.APP_URL || 'http://localhost:8080';

async function notifyLeadCaptured(project, lead) {
  try {
    const owner = await db.findOne('users', { id: project.userId });
    if (!owner) return;

    await sendLeadNotification(owner.email, { projectName: project.name, leadData: lead.data });

    if (owner.phone && owner.smsAlertsEnabled) {
      const preview = Object.values(lead.data || {}).slice(0, 2).join(', ');
      await sendSms(
        owner.phone,
        `AvatarPlatform: new lead on "${project.name}"${preview ? ` — ${preview}` : ''}. View: ${APP_URL()}/dashboard`
      );
    }
  } catch (e) {
    logger.error({ err: e.message, projectId: project.id }, 'lead notification failed');
  }
}

async function notifyTourBooked(project, { visitorName, visitorEmail, when, meetLink }) {
  try {
    const owner = await db.findOne('users', { id: project.userId });
    if (!owner) return;

    await sendTourBookedNotification(owner.email, {
      projectName: project.name, visitorName, visitorEmail, when, meetLink,
    });

    if (owner.phone && owner.smsAlertsEnabled) {
      await sendSms(owner.phone, `AvatarPlatform: ${visitorName} booked a tour on "${project.name}" for ${when}.`);
    }
  } catch (e) {
    logger.error({ err: e.message, projectId: project.id }, 'tour notification failed');
  }
}

module.exports = { notifyLeadCaptured, notifyTourBooked };
