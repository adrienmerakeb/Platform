// config/mailer.js
// Nodemailer configuration + helpers for password reset and test emails

import nodemailer from 'nodemailer';

// -----------------------------------------------------------------------------
// SMTP configuration
// -----------------------------------------------------------------------------

const useRealSmtp = !!(
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
);

const MAIL_FROM =
  process.env.MAIL_FROM ||
  process.env.SMTP_USER ||
  'no-reply@wanderpal.local';

export const transporter = nodemailer.createTransport(
  useRealSmtp
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: false, // STARTTLS
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        logger: true,
        debug: true
      }
    : {
        // Dev mode: logs emails as JSON instead of actually sending
        jsonTransport: true
      }
);

// Verify transporter on startup
(async () => {
  try {
    await transporter.verify();
    if (useRealSmtp) {
      console.log('[SMTP] transporter ready (real SMTP)');
    } else if (transporter.options && transporter.options.jsonTransport) {
      console.log(
        '[SMTP] jsonTransport active (DEV mode, emails logged to console)'
      );
    }
  } catch (e) {
    if (transporter.options && transporter.options.jsonTransport) {
      console.log(
        '[SMTP] jsonTransport active (DEV mode, verify failed but using JSON transport)'
      );
    } else {
      console.warn('[SMTP] verify() failed:', e?.message || e);
    }
  }
})();

// -----------------------------------------------------------------------------
// Helper: generic mail send
// -----------------------------------------------------------------------------

/**
 * Low-level helper. You can use this in routes that send custom emails.
 * @param {object} opts - nodemailer sendMail options (to, subject, text/html, etc.)
 */
export async function sendMail(opts = {}) {
  try {
    const info = await transporter.sendMail({
      from: MAIL_FROM,
      ...opts
    });
    return { ok: true, info };
  } catch (err) {
    console.warn('[SMTP] sendMail failed:', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

// -----------------------------------------------------------------------------
// Helper: password-reset style email
// -----------------------------------------------------------------------------

/**
 * Send a password reset (or similar) email.
 *
 * @param {object} params
 * @param {string} params.to
 * @param {string} params.subject
 * @param {string} [params.html]
 * @param {string} [params.text]
 */
export async function sendResetMail({ to, subject, html, text }) {
  return sendMail({
    to,
    subject,
    html,
    text
  });
}

// -----------------------------------------------------------------------------
// (Optional) Dev helpers, used by /api/dev/test-mail, /api/dev/mail-test routes
// -----------------------------------------------------------------------------

/**
 * Simple test email used in dev routes.
 */
export async function sendTestMail(toOverride) {
  const to =
    toOverride ||
    (process.env.MAIL_FROM?.match(/<(.+)>/)?.[1] ?? process.env.MAIL_FROM) ||
    process.env.SMTP_USER;

  return sendMail({
    to,
    subject: 'WanderPal SMTP test',
    text: 'If you receive this, SMTP sending works.',
    html: '<p>If you receive this, SMTP sending works.</p>'
  });
}
