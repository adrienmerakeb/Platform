// config/mailer.js
// Nodemailer transporter + helper for reset emails

import nodemailer from 'nodemailer';

// Load env if not already loaded elsewhere
import dotenv from 'dotenv';
dotenv.config();

const useRealSmtp = !!(
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
);

export const transporter = nodemailer.createTransport(
  useRealSmtp
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        logger: true,
        debug: true
      }
    : {
        // Dev mode: log mails to console instead of sending
        jsonTransport: true
      }
);

// Verify transporter on startup (non-fatal if it fails)
(async () => {
  try {
    await transporter.verify();
    if (useRealSmtp) {
      console.log('[SMTP] transporter ready (real SMTP)');
    } else {
      console.log('[SMTP] jsonTransport active (DEV mode, emails logged to console)');
    }
  } catch (e) {
    if (transporter.options && transporter.options.jsonTransport) {
      console.log('[SMTP] jsonTransport active (DEV mode, verify failed but that is OK)');
    } else {
      console.warn('[SMTP] verify() failed:', e?.message || e);
    }
  }
})();

/**
 * Helper to send reset / notification mails
 *
 * @param {Object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.html]
 * @param {string} [opts.text]
 */
export async function sendResetMail({ to, subject, html, text }) {
  try {
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || 'no-reply@wanderpal.local',
      to,
      subject,
      html,
      text
    });
    return { ok: true, info };
  } catch (err) {
    console.warn('[SMTP] sendMail failed:', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export default {
  transporter,
  sendResetMail
};
