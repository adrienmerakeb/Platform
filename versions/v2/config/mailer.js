// config/mailer.js
import nodemailer from 'nodemailer';

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
    : { jsonTransport: true }
);

export async function setupMailer() {
  try {
    await transporter.verify();
    if (useRealSmtp) {
      console.log('[SMTP] transporter ready (real SMTP)');
    } else {
      console.log('[SMTP] jsonTransport active (DEV mode, emails logged to console)');
    }
  } catch (e) {
    console.warn('[SMTP] verify() failed:', e?.message || e);
  }
}

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
