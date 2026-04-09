// routes/authPartner.js
// PARTNER AUTH (local): register / login / forgot / reset

import express from 'express';
import { getDB } from '../config/db.js';
import { safeLog } from '../middleware/auth.js';

import {
  authLimiter,
  getClientIp,
  hashPassword,
  verifyPassword,
  setOrgLoginCookie
} from '../middleware/auth.js';
import { sendResetMail } from '../config/mailer.js';

const router = express.Router();

let db;
function ensureDB() {
  if (!db) db = getDB();
  return db;
}

const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'http://localhost:3000';

// -----------------------------------------------------------------------------
// PARTNER REGISTER
// POST /api/partner/register
// -----------------------------------------------------------------------------
router.post('/partner/register', authLimiter, async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);

  try {
    const {
      company_name,
      email,
      password,
      website = null,
      vat_id = null
    } = req.body || {};

    if (!company_name || !email || !password) {
      await safeLog({
        userId: null,
        provider: 'partner-register',
        ip,
        success: 0
      });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const password_hash = await hashPassword(password);

    await db.run(
      `INSERT INTO partners (company_name, email, password_hash, website, vat_id)
       VALUES (?,?,?,?,?)`,
      [company_name, email, password_hash, website, vat_id]
    );

    await safeLog({
      userId: null,
      provider: 'partner-register',
      ip,
      success: 1
    });
    res.json({ ok: true });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      await safeLog({
        userId: null,
        provider: 'partner-register',
        ip,
        success: 0
      });
      return res
        .status(409)
        .json({ error: 'Email already in use for partners' });
    }
    await safeLog({
      userId: null,
      provider: 'partner-register',
      ip,
      success: 0
    });
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// PARTNER LOGIN
// POST /api/partner/login
// -----------------------------------------------------------------------------
router.post('/partner/login', authLimiter, async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);

  try {
    const { company_name, email, password, remember = false } =
      req.body || {};
    if (!company_name || !email || !password) {
      await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }

    const row = await db.get('SELECT * FROM partners WHERE email = ?', [
      email
    ]);
    if (!row) {
      await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (
      row.company_name.trim().toLowerCase() !==
      company_name.trim().toLowerCase()
    ) {
      await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
      return res
        .status(401)
        .json({ error: 'Invalid company or credentials' });
    }

    if (Number(row.suspended) === 1) {
      await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
      return res.status(403).json({
        error:
          'This partner account has been suspended. Please contact abc@hotmail.com for more information.'
      });
    }

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
      return res
        .status(401)
        .json({ error: 'Invalid company or credentials' });
    }

    setOrgLoginCookie(res, row, 'partner', !!remember);
    await safeLog({ userId: null, provider: 'partner', ip, success: 1 });
    res.json({ ok: true });
  } catch {
    await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// PARTNER FORGOT PASSWORD
// POST /api/partner/forgot
// -----------------------------------------------------------------------------
router.post('/partner/forgot', async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);

  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      await safeLog({ provider: 'partner-forgot', ip, success: 0 });
      return res.status(400).json({ error: 'Missing email' });
    }

    const partner = await db.get(
      `SELECT id, email FROM partners WHERE LOWER(email) = ?`,
      [email]
    );

    // Always respond ok even if not found
    if (!partner) {
      await safeLog({ provider: 'partner-forgot', ip, success: 1 });
      return res.json({ ok: true });
    }

    const token =
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);
    const expires = new Date(Date.now() + 1000 * 60 * 30).toISOString();

    await db.run(
      `INSERT INTO reset_tokens_partner (email, token, expires_at) VALUES (?, ?, ?)`,
      [email, token, expires]
    );

    const resetUrl = `${OAUTH_BASE_URL}/partner-reset.html?token=${encodeURIComponent(
      token
    )}&email=${encodeURIComponent(email)}`;

    const r = await sendResetMail({
      to: email,
      subject: 'Reset your Partner password',
      text: `Reset your password: ${resetUrl}`,
      html: `<p>Reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
    });

    if (!r.ok) {
      await safeLog({ provider: 'partner-forgot', ip, success: 0 });
      return res.status(500).json({ error: 'Could not send reset link.' });
    }

    await safeLog({ provider: 'partner-forgot', ip, success: 1 });
    const dev = process.env.NODE_ENV !== 'production';
    return res.json({
      ok: true,
      ...(dev ? { dev: true, resetUrl } : {})
    });
  } catch (e) {
    console.error('[PARTNER FORGOT] error:', e);
    await safeLog({ provider: 'partner-forgot', ip, success: 0 });
    return res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// PARTNER RESET PASSWORD
// POST /api/partner/reset
// -----------------------------------------------------------------------------
router.post('/partner/reset', async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);
  const { token, email } = req.body || {};
  const pwd =
    (req.body && (req.body.password || req.body.newPassword)) || '';

  try {
    if (!token || !email || !pwd) {
      await safeLog({ provider: 'partner-reset', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }
    const em = String(email).trim().toLowerCase();

    const row = await db.get(
      `SELECT * FROM reset_tokens_partner
       WHERE token = ? AND LOWER(email) = ? AND expires_at > CURRENT_TIMESTAMP`,
      [token, em]
    );
    if (!row) {
      await safeLog({ provider: 'partner-reset', ip, success: 0 });
      return res
        .status(400)
        .json({ error: 'Invalid or expired reset link' });
    }

    const hash = await hashPassword(pwd);
    const upd = await db.run(
      `UPDATE partners SET password_hash = ? WHERE LOWER(email) = ?`,
      [hash, em]
    );
    if (upd.changes === 0) {
      await safeLog({ provider: 'partner-reset', ip, success: 0 });
      return res.status(404).json({ error: 'Account not found' });
    }

    await db.run(`DELETE FROM reset_tokens_partner WHERE token = ?`, [
      token
    ]);
    await safeLog({ provider: 'partner-reset', ip, success: 1 });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[PARTNER RESET] error:', e);
    await safeLog({ provider: 'partner-reset', ip, success: 0 });
    return res.status(500).json({ error: 'Server error' });
  }
});

export default router;

