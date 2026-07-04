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
  await send({
    to: toEmail,
    subject: 'Reset your AvatarPlatform password',
    text: `Click this link to reset your password (expires in 1 hour):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin:0 0 16px;font-size:20px">Reset your password</h2>
        <p style="color:#555;line-height:1.6">Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
        <a href="${link}" style="display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Reset password</a>
        <p style="color:#999;font-size:12px">If you didn't request a password reset, you can safely ignore this email.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#bbb;font-size:11px">AvatarPlatform · <a href="${BASE_URL()}" style="color:#bbb">${BASE_URL()}</a></p>
      </div>`,
  });
}

/**
 * Send a welcome email after signup.
 * @param {string} toEmail
 * @param {string} name
 */
async function sendWelcome(toEmail, name) {
  const displayName = name || 'there';
  await send({
    to: toEmail,
    subject: 'Welcome to AvatarPlatform',
    text: `Hi ${displayName},\n\nThanks for signing up! Get started by creating your first chatbot at ${BASE_URL()}/dashboard.\n\nIf you have any questions, reply to this email or visit ${BASE_URL()}/contact.\n\n— The AvatarPlatform team`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin:0 0 16px;font-size:20px">Welcome to AvatarPlatform, ${displayName}!</h2>
        <p style="color:#555;line-height:1.6">You're all set. Create your first AI talking-character chatbot in minutes.</p>
        <a href="${BASE_URL()}/dashboard" style="display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Go to dashboard →</a>
        <p style="color:#555;line-height:1.6;font-size:13px">Questions? <a href="${BASE_URL()}/contact" style="color:#7c6af5">Book a setup call</a> or browse the <a href="${BASE_URL()}/docs" style="color:#7c6af5">docs</a>.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#bbb;font-size:11px">AvatarPlatform · <a href="${BASE_URL()}" style="color:#bbb">${BASE_URL()}</a></p>
      </div>`,
  });
}

module.exports = { sendPasswordReset, sendWelcome };
