import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";

let _transporter: Transporter | null | undefined;

/** Lazily built; null (not undefined) once we've confirmed SMTP isn't configured. */
function getTransporter(): Transporter | null {
  if (_transporter !== undefined) return _transporter;

  if (!env.smtpHost || !env.smtpUser || !env.smtpPass) {
    _transporter = null;
    return _transporter;
  }

  _transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    auth: { user: env.smtpUser, pass: env.smtpPass },
  });
  return _transporter;
}

/**
 * Sends an email, or logs a warning and no-ops if SMTP isn't configured — so the rest of the
 * app (signup, bookings, password reset) keeps working in an environment that hasn't set up
 * email yet. Never throws; a broken mail send shouldn't fail the request that triggered it.
 */
export async function sendMail(opts: { to: string; subject: string; html: string; text: string }): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`SMTP not configured — skipping email "${opts.subject}" to ${opts.to}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: env.smtpFrom,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
  } catch (err) {
    console.error(`Failed to send email "${opts.subject}" to ${opts.to}`, err);
  }
}

function wrapHtml(bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 16px">${env.appName}</h2>
    ${bodyHtml}
    <p style="margin-top:32px;font-size:12px;color:#888">${env.appName} · ${env.appUrl}</p>
  </div>`;
}

export async function sendVerificationEmail(to: string, name: string, token: string) {
  const url = `${env.appUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  await sendMail({
    to,
    subject: `Verify your email — ${env.appName}`,
    html: wrapHtml(
      `<p>Hi ${name},</p><p>Confirm your email address to finish setting up your account:</p>
       <p><a href="${url}" style="color:#4d7cff">Verify email</a></p>
       <p style="color:#888;font-size:13px">This link expires in 24 hours.</p>`
    ),
    text: `Hi ${name},\n\nVerify your email: ${url}\n\nThis link expires in 24 hours.`,
  });
}

export async function sendPasswordResetEmail(to: string, name: string, token: string) {
  const url = `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({
    to,
    subject: `Reset your password — ${env.appName}`,
    html: wrapHtml(
      `<p>Hi ${name},</p><p>Someone requested a password reset for this account. If that was you:</p>
       <p><a href="${url}" style="color:#4d7cff">Reset your password</a></p>
       <p style="color:#888;font-size:13px">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`
    ),
    text: `Hi ${name},\n\nReset your password: ${url}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  });
}

export async function sendBookingConfirmationEmail(opts: {
  to: string;
  name: string;
  otherPartyName: string;
  startAt: Date;
  durationMinutes: number;
  isFreeSession: boolean;
  priceCents: number;
  currency: string;
}) {
  const when = opts.startAt.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  const price = opts.isFreeSession ? "Free" : `$${(opts.priceCents / 100).toFixed(2)} ${opts.currency.toUpperCase()}`;
  await sendMail({
    to: opts.to,
    subject: `Booking confirmed with ${opts.otherPartyName}`,
    html: wrapHtml(
      `<p>Hi ${opts.name},</p><p>Your session with ${opts.otherPartyName} is confirmed:</p>
       <ul><li>${when}</li><li>${opts.durationMinutes} minutes</li><li>${price}</li></ul>
       <p>You'll be able to join the video call from your dashboard shortly before it starts.</p>`
    ),
    text: `Hi ${opts.name},\n\nYour session with ${opts.otherPartyName} is confirmed:\n${when}\n${opts.durationMinutes} minutes\n${price}\n\nJoin from your dashboard shortly before it starts.`,
  });
}

export async function sendBookingReminderEmail(opts: {
  to: string;
  name: string;
  otherPartyName: string;
  startAt: Date;
  joinUrl: string;
}) {
  const when = opts.startAt.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  await sendMail({
    to: opts.to,
    subject: `Starting soon: your session with ${opts.otherPartyName}`,
    html: wrapHtml(
      `<p>Hi ${opts.name},</p><p>Your session with ${opts.otherPartyName} starts soon — ${when}.</p>
       <p><a href="${opts.joinUrl}" style="color:#4d7cff">Join the call</a></p>`
    ),
    text: `Hi ${opts.name},\n\nYour session with ${opts.otherPartyName} starts soon — ${when}.\n\nJoin: ${opts.joinUrl}`,
  });
}
