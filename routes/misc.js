// routes/misc.js
// Dashboard redirect, /api/me, logout, /api/host/me, /api/partner/me + dev mail tests

import express from 'express';
import jwt from 'jsonwebtoken';

import { getDb } from '../config/db.js';
import { authRequired, JWT_SECRET } from '../middleware/auth.js';
import { sendResetMail } from '../config/mailer.js';

const router = express.Router();
const db = getDb();

/* ---------------- /dashboard (role-aware redirect) ---------------- */

// GET /dashboard
router.get('/dashboard', (req, res) => {
  try {
    const token = req.cookies?.token;
    if (!token) return res.redirect('/');

    const u = jwt.verify(token, JWT_SECRET);
    switch (u.role) {
      case 'host':
        return res.redirect('/dashboard-host.html');
      case 'partner':
        return res.redirect('/dashboard-partner.html');
      case 'visitor':
      default:
        return res.redirect('/dashboard.html');
    }
  } catch {
    return res.redirect('/');
  }
});

/* ---------------- /api/me (current user from JWT) ---------------- */

// GET /api/me
router.get('/api/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

/* ---------------- /api/logout (clear cookie) ---------------- */

// POST /api/logout
router.post('/api/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!process.env.COOKIE_SECURE
  });
  res.json({ ok: true });
});

/* ---------------- /api/host/me ---------------- */

// GET /api/host/me
router.get('/api/host/me', async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ error: 'Not logged in' });

    const u = jwt.verify(token, JWT_SECRET);
    if (u.role !== 'host') {
      return res.status(403).json({ error: 'Not a host token' });
    }

    const row = await db.get(
      `SELECT id, company_name, email, host_type, selected_services,
              website, vat_id, suspended, created_at
         FROM hosts
        WHERE id = ?`,
      [u.id]
    );
    if (!row) return res.status(404).json({ error: 'Host not found' });

    res.json({ host: row });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/* ---------------- /api/partner/me ---------------- */

// GET /api/partner/me
router.get('/api/partner/me', (req, res) => {
  try {
    console.log('[PARTNER /me] cookies:', req.cookies);
    const raw = req.cookies?.token;

    if (!raw || typeof raw !== 'string') {
      console.log(
        '[PARTNER /me] no valid token cookie (type:',
        typeof raw,
        ')'
      );
      return res.status(401).json({ error: 'Not logged in' });
    }

    const u = jwt.verify(raw, JWT_SECRET);
    console.log('[PARTNER /me] decoded token:', u);

    if (u.role !== 'partner') {
      console.log('[PARTNER /me] wrong role:', u.role);
      return res.status(403).json({ error: 'Not a partner token' });
    }

    res.json({ email: u.email, company_name: u.name });
  } catch (e) {
    console.error('[PARTNER /me] verify error:', e);
    res.status(401).json({ error: 'Invalid token' });
  }
});

/* ---------------- DEV: SMTP test endpoints ---------------- */

// GET /api/dev/test-mail?to=someone@example.com
router.get('/api/dev/test-mail', async (req, res) => {
  try {
    const to =
      req.query.to ||
      process.env.SMTP_USER ||
      process.env.MAIL_FROM;

    if (!to) {
      return res.status(400).json({
        error:
          'No destination address. Set ?to= or SMTP_USER/MAIL_FROM in env.'
      });
    }

    const { ok, info, error } = await sendResetMail({
      to,
      subject: 'WanderPal SMTP test',
      text: 'If you receive this, SMTP sending works.',
      html: '<p>If you receive this, SMTP sending works.</p>'
    });

    if (!ok) {
      console.error('[MAIL test] send failed:', error);
      return res.status(500).json({ error: 'Test send failed', detail: error });
    }

    return res.json({
      ok: true,
      accepted: info?.accepted,
      rejected: info?.rejected,
      response: info?.response
    });
  } catch (e) {
    console.error('[MAIL test] error:', e);
    return res.status(500).json({
      error: 'Test send failed',
      detail: String(e?.message || e)
    });
  }
});

// GET /api/dev/mail-test
router.get('/api/dev/mail-test', async (_req, res) => {
  try {
    const to =
      process.env.MAIL_FROM?.match(/<(.+)>/)?.[1] ||
      process.env.MAIL_FROM ||
      process.env.SMTP_USER;

    if (!to) {
      return res.status(400).json({
        error:
          'No MAIL_FROM / SMTP_USER configured to send dev mail to.'
      });
    }

    const { ok, info, error } = await sendResetMail({
      to,
      subject: 'WanderPal SMTP test',
      text: 'This is a test email from /api/dev/mail-test.',
      html: '<p>This is a test email from <code>/api/dev/mail-test</code>.</p>'
    });

    if (!ok) {
      console.error('[MAIL /api/dev/mail-test] send failed:', error);
      return res
        .status(500)
        .json({ error: 'Test send failed', detail: error });
    }

    res.json({ ok: true, info: !!info });
  } catch (e) {
    console.error('Mail test failed:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

export default router;
