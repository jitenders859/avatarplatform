/**
 * Email service — wraps nodemailer with lazy transporter init.
 *
 * Configure via env vars:
 *   SMTP_HOST   — e.g. smtp.sendgrid.net  (required to enable sending)
 *   SMTP_PORT   — default 587
 *   SMTP_USER   — SMTP username
 *   SMTP_PASS   — SMTP password / API key
 *   SMTP_FROM   — From address (falls back to SMTP_USER)
 *   APP_URL     — Base URL for links in emails (default http://localhost:8080)
 *
 * When SMTP_HOST is not set the module logs a warning and all sends are
 * no-ops so the server boots and functions without email configured.
 */
const nodemailer = require('nodemailer');
const logger = require('../logger').child({ module: 'services/email' });
const { getTemplate } = require('./emailTemplates');

let _transport = null;

function getTransport() {
  if (_transport) return _transport;
  if (!process.env.SMTP_HOST) return null;
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transport;
}

const FROM = () => process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@avatarplatform.ai';
const BASE_URL = () => process.env.APP_URL || 'http://localhost:8080';

// Fills a DB/fallback template's placeholder tokens (literal `${...}` text,
// preserved verbatim from the original template literals — see
// services/emailTemplates.js) with real values. Deliberately a plain
// substring replace, not a templating engine (Handlebars/Mustache): every
// occurrence of `token` is a literal string search-and-replace, so a
// template row edited from the admin panel behaves exactly like the
// original inline template literals did.
function interpolate(str, replacements) {
  let out = str;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(value);
  }
  return out;
}

async function send(opts) {
  const transport = getTransport();
  if (!transport) {
    logger.warn({ to: opts.to, subject: opts.subject }, 'SMTP not configured — email not sent');
    return;
  }
  try {
    await transport.sendMail({ from: FROM(), ...opts });
    logger.info({ to: opts.to, subject: opts.subject }, 'email sent');
  } catch (e) {
    logger.error({ err: e.message, to: opts.to }, 'email send failed');
  }
}

/**
 * Send a password-reset email.
 * @param {string} toEmail
 * @param {string} resetToken
 */
async function sendPasswordReset(toEmail, resetToken) {
  const link = `${BASE_URL()}/reset-password?token=${resetToken}`;
  const { subject, body } = await getTemplate('password_reset');
  const html = interpolate(body, {
    '${link}': link,
    '${BASE_URL()}': BASE_URL(),
  });
  await send({
    to: toEmail,
    subject,
    text: `Click this link to reset your password (expires in 1 hour):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
    html,
  });
}

/**
 * Send an email-verification link. Reuses the reset-token pattern
 * (random token + expiry column, consumed once) rather than a JWT, so a
 * verification link can't outlive a password change/account deletion the
 * way a signed token with no server-side revocation would.
 * @param {string} toEmail
 * @param {string} verifyToken
 */
async function sendVerificationEmail(toEmail, verifyToken) {
  const link = `${BASE_URL()}/verify-email?token=${verifyToken}`;
  const { subject, body } = await getTemplate('verification');
  const html = interpolate(body, {
    '${link}': link,
    '${BASE_URL()}': BASE_URL(),
  });
  await send({
    to: toEmail,
    subject,
    text: `Click this link to verify your email (expires in 24 hours):\n\n${link}\n\nIf you didn't create an AvatarPlatform account, ignore this email.`,
    html,
  });
}

/**
 * Notify a user they've been added as a read-only team member on a
 * project. The invitee must already have an AvatarPlatform account (the
 * project_members row is created up front, not as a pending invite —
 * see routes/projects.js), so this just points them at the dashboard
 * rather than a signup/accept flow.
 * @param {string} toEmail
 * @param {string} projectName
 * @param {string} inviterEmail
 */
async function sendTeamInviteEmail(toEmail, projectName, inviterEmail) {
  const { subject, body } = await getTemplate('team_invite');
  const filledSubject = interpolate(subject, { '${projectName}': projectName });
  const html = interpolate(body, {
    '${escapeHtml(inviterEmail)}': escapeHtml(inviterEmail),
    '${escapeHtml(projectName)}': escapeHtml(projectName),
    '${BASE_URL()}': BASE_URL(),
  });
  await send({
    to: toEmail,
    subject: filledSubject,
    text: `${inviterEmail} added you as a team member on "${projectName}". You can now view its conversations and analytics from your dashboard: ${BASE_URL()}/dashboard`,
    html,
  });
}

/**
 * Send a welcome email after signup.
 * @param {string} toEmail
 * @param {string} name
 */
async function sendWelcome(toEmail, name) {
  const displayName = name || 'there';
  const { subject, body } = await getTemplate('welcome');
  const html = interpolate(body, {
    '${displayName}': displayName,
    '${BASE_URL()}': BASE_URL(),
  });
  await send({
    to: toEmail,
    subject,
    text: `Hi ${displayName},\n\nThanks for signing up! Get started by creating your first chatbot at ${BASE_URL()}/dashboard.\n\nIf you have any questions, reply to this email or visit ${BASE_URL()}/contact.\n\n— The AvatarPlatform team`,
    html,
  });
}

/**
 * Relay a contact-page message to support. The visitor's address goes in
 * replyTo (not from — most SMTP providers reject or spam-flag mail sent
 * with an arbitrary From), so replying in the inbox goes straight back to
 * the visitor.
 * @param {{ name: string, email: string, message: string }} fields
 */
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendContactMessage({ name, email, message }) {
  const to = process.env.CONTACT_TO_EMAIL || FROM();
  const { subject, body } = await getTemplate('contact_message');
  const filledSubject = interpolate(subject, { '${name}': name });
  const html = interpolate(body, {
    '${escapeHtml(name)}': escapeHtml(name),
    '${escapeHtml(email)}': escapeHtml(email),
    '${escapeHtml(message)}': escapeHtml(message),
  });
  await send({
    to,
    replyTo: email,
    subject: filledSubject,
    text: `From: ${name} <${email}>\n\n${message}`,
    html,
  });
}

/**
 * Send a "you're approaching your plan limit" warning email, with an
 * upgrade CTA. `label`/`current`/`limit` describe whichever metric is
 * closest to its cap (see services/usage.js#runUsageAlertSweep).
 * @param {string} toEmail
 * @param {{ planName: string, label: string, current: number, limit: number }} info
 */
async function sendUsageLimitWarning(toEmail, { planName, label, current, limit }) {
  const percent = limit > 0 ? Math.round((current / limit) * 100) : 100;
  const { subject, body } = await getTemplate('usage_limit_warning');
  const replacements = {
    '${planName}': escapeHtml(planName),
    '${label}': escapeHtml(label),
    '${current}': String(current),
    '${limit}': String(limit),
    '${percent}': String(percent),
    '${BASE_URL()}': BASE_URL(),
  };
  await send({
    to: toEmail,
    subject: interpolate(subject, replacements),
    text: `You've used ${current} / ${limit} ${label} on your ${planName} plan this billing period (${percent}%). Upgrade to add more: ${BASE_URL()}/billing`,
    html: interpolate(body, replacements),
  });
}

/**
 * Send a "you've hit your plan limit" email, with an upgrade CTA.
 * @param {string} toEmail
 * @param {{ planName: string, label: string, current: number, limit: number }} info
 */
async function sendUsageLimitReached(toEmail, { planName, label, current, limit }) {
  const { subject, body } = await getTemplate('usage_limit_reached');
  const replacements = {
    '${planName}': escapeHtml(planName),
    '${label}': escapeHtml(label),
    '${current}': String(current),
    '${limit}': String(limit),
    '${BASE_URL()}': BASE_URL(),
  };
  await send({
    to: toEmail,
    subject: interpolate(subject, replacements),
    text: `You've used ${current} / ${limit} ${label} on your ${planName} plan this billing period — this feature is paused until your next billing period unless you upgrade: ${BASE_URL()}/billing`,
    html: interpolate(body, replacements),
  });
}

/**
 * Notify the project owner that a visitor just completed a lead-capture
 * form (all required capture_fields filled in) on their chatbot.
 * @param {string} toEmail
 * @param {{ projectName: string, leadData: Record<string,string> }} info
 */
async function sendLeadNotification(toEmail, { projectName, leadData }) {
  const entries = Object.entries(leadData || {});
  const rowsHtml = entries
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#999;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:4px 0;color:#333">${escapeHtml(String(v))}</td></tr>`)
    .join('');
  const rowsText = entries.map(([k, v]) => `${k}: ${v}`).join('\n');
  const { subject, body } = await getTemplate('lead_notification');
  const replacements = {
    '${escapeHtml(projectName)}': escapeHtml(projectName),
    '${rowsHtml}': rowsHtml,
    '${BASE_URL()}': BASE_URL(),
  };
  await send({
    to: toEmail,
    subject: interpolate(subject, replacements),
    text: `New lead captured on "${projectName}":\n\n${rowsText}\n\nView it in your dashboard: ${BASE_URL()}/dashboard`,
    html: interpolate(body, replacements),
  });
}

/**
 * Notify the project owner that a visitor just booked a tour. This is in
 * addition to Google's own calendar-invite email (sent to the owner and
 * visitor directly by Google when the event is created — see
 * services/googleCalendar.js's insertEvent), so the owner also gets an
 * app-branded heads-up that reaches them even if the calendar invite ends
 * up in a folder they don't watch closely.
 * @param {string} toEmail
 * @param {{ projectName: string, visitorName: string, visitorEmail: string, when: string, meetLink?: string }} info
 */
async function sendTourBookedNotification(toEmail, { projectName, visitorName, visitorEmail, when, meetLink }) {
  const { subject, body } = await getTemplate('tour_booked_notification');
  const filledSubject = interpolate(subject, { '${escapeHtml(projectName)}': escapeHtml(projectName) });
  const meetLinkHtml = meetLink
    ? `<p style="color:#555;line-height:1.6">Video call link: <a href="${meetLink}" style="color:#7c6af5">${escapeHtml(meetLink)}</a></p>`
    : '';
  const replacements = {
    '${escapeHtml(projectName)}': escapeHtml(projectName),
    '${escapeHtml(visitorName)}': escapeHtml(visitorName),
    '${escapeHtml(visitorEmail)}': escapeHtml(visitorEmail),
    '${escapeHtml(when)}': escapeHtml(when),
    '${meetLinkHtml}': meetLinkHtml,
    '${BASE_URL()}': BASE_URL(),
  };
  await send({
    to: toEmail,
    subject: filledSubject,
    text: `${visitorName} <${visitorEmail}> booked a tour on "${projectName}" for ${when}.${meetLink ? `\nVideo call link: ${meetLink}` : ''}`,
    html: interpolate(body, replacements),
  });
}

module.exports = {
  sendPasswordReset, sendWelcome, sendContactMessage, sendVerificationEmail, sendTeamInviteEmail,
  sendUsageLimitWarning, sendUsageLimitReached, sendLeadNotification, sendTourBookedNotification,
};
