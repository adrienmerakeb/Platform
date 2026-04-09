// routes/authHost.js
// HOST AUTH (local): register / login / forgot / reset + hosts listing

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
// HOST REGISTER
// POST /api/host/register
// -----------------------------------------------------------------------------
router.post('/host/register', authLimiter, async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);

  try {
    const {
      company_name,
      email,
      password,
      host_type = null,
      selected_services = [],
      website = null,
      vat_id = null
    } = req.body || {};

    if (!company_name || !email || !password) {
      await safeLog({
        userId: null,
        provider: 'host-register',
        ip,
        success: 0
      });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const password_hash = await hashPassword(password);
    const services =
      Array.isArray(selected_services) && selected_services.length
        ? JSON.stringify(selected_services)
        : null;

    await db.run(
      `INSERT INTO hosts (company_name, email, password_hash, host_type, selected_services, website, vat_id)
       VALUES (?,?,?,?,?,?,?)`,
      [company_name, email, password_hash, host_type, services, website, vat_id]
    );

    await safeLog({
      userId: null,
      provider: 'host-register',
      ip,
      success: 1
    });
    res.json({ ok: true });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      await safeLog({
        userId: null,
        provider: 'host-register',
        ip,
        success: 0
      });
      return res
        .status(409)
        .json({ error: 'Email already in use for hosts' });
    }
    await safeLog({
      userId: null,
      provider: 'host-register',
      ip,
      success: 0
    });
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// HOST LOGIN
// POST /api/host/login
// -----------------------------------------------------------------------------
router.post('/host/login', authLimiter, async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);

  try {
    const { company_name, email, password, remember = false } = req.body || {};
    if (!company_name || !email || !password) {
      await safeLog({ userId: null, provider: 'host', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }

    const row = await db.get('SELECT * FROM hosts WHERE email = ?', [email]);
    if (!row) {
      await safeLog({ userId: null, provider: 'host', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (
      row.company_name.trim().toLowerCase() !==
      company_name.trim().toLowerCase()
    ) {
      await safeLog({ userId: null, provider: 'host', ip, success: 0 });
      return res
        .status(401)
        .json({ error: 'Invalid company or credentials' });
    }

    if (Number(row.suspended) === 1) {
      await safeLog({ userId: null, provider: 'host', ip, success: 0 });
      return res.status(403).json({
        error:
          'This host account has been suspended. Please contact abc@hotmail.com for assistance.'
      });
    }

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      await safeLog({ userId: null, provider: 'host', ip, success: 0 });
      return res
        .status(401)
        .json({ error: 'Invalid company or credentials' });
    }

    setOrgLoginCookie(res, row, 'host', !!remember);
    await safeLog({ userId: null, provider: 'host', ip, success: 1 });
    res.json({ ok: true });
  } catch {
    await safeLog({ userId: null, provider: 'host', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// HOST FORGOT PASSWORD
// POST /api/host/forgot
// -----------------------------------------------------------------------------
router.post('/host/forgot', async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);

  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      await safeLog({ provider: 'host-forgot', ip, success: 0 });
      return res.status(400).json({ error: 'Missing email' });
    }

    const host = await db.get(
      `SELECT id, email FROM hosts WHERE LOWER(email) = ?`,
      [email]
    );
    // Always respond ok
    if (!host) {
      await safeLog({ provider: 'host-forgot', ip, success: 1 });
      return res.json({ ok: true });
    }

    const token =
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);
    const expires = new Date(Date.now() + 1000 * 60 * 30).toISOString();

    await db.run(
      `INSERT INTO reset_tokens_host (email, token, expires_at) VALUES (?, ?, ?)`,
      [email, token, expires]
    );

    const resetUrl = `${OAUTH_BASE_URL}/host-reset.html?token=${encodeURIComponent(
      token
    )}&email=${encodeURIComponent(email)}`;

    const r = await sendResetMail({
      to: email,
      subject: 'Reset your Host password',
      text: `Reset your password: ${resetUrl}`,
      html: `<p>Reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
    });

    if (!r.ok) {
      await safeLog({ provider: 'host-forgot', ip, success: 0 });
      return res.status(500).json({ error: 'Could not send reset link.' });
    }

    await safeLog({ provider: 'host-forgot', ip, success: 1 });
    const dev = process.env.NODE_ENV !== 'production';
    return res.json({
      ok: true,
      ...(dev ? { dev: true, resetUrl } : {})
    });
  } catch (e) {
    console.error('[HOST FORGOT] error:', e);
    await safeLog({ provider: 'host-forgot', ip, success: 0 });
    return res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// HOST RESET PASSWORD
// POST /api/host/reset
// -----------------------------------------------------------------------------
router.post('/host/reset', async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);
  const { token, email } = req.body || {};
  const pwd =
    (req.body && (req.body.password || req.body.newPassword)) || '';

  try {
    if (!token || !email || !pwd) {
      await safeLog({ provider: 'host-reset', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }
    const em = String(email).trim().toLowerCase();

    const row = await db.get(
      `SELECT * FROM reset_tokens_host
       WHERE token = ? AND LOWER(email) = ? AND expires_at > CURRENT_TIMESTAMP`,
      [token, em]
    );
    if (!row) {
      await safeLog({ provider: 'host-reset', ip, success: 0 });
      return res
        .status(400)
        .json({ error: 'Invalid or expired reset link' });
    }

    const hash = await hashPassword(pwd);
    const upd = await db.run(
      `UPDATE hosts SET password_hash = ? WHERE LOWER(email) = ?`,
      [hash, em]
    );
    if (upd.changes === 0) {
      await safeLog({ provider: 'host-reset', ip, success: 0 });
      return res.status(404).json({ error: 'Account not found' });
    }

    await db.run(`DELETE FROM reset_tokens_host WHERE token = ?`, [token]);
    await safeLog({ provider: 'host-reset', ip, success: 1 });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[HOST RESET] error:', e);
    await safeLog({ provider: 'host-reset', ip, success: 0 });
    return res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// HOSTS LIST (simple) for front-end use if needed
// GET /api/hosts
// -----------------------------------------------------------------------------
router.get('/hosts', async (_req, res) => {
  const db = ensureDB();
  try {
    const rows = await db.all(
      'SELECT id, company_name, email, host_type, selected_services, website, vat_id FROM hosts'
    );
    res.json(rows);
  } catch (e) {
    console.error('[HOSTS LIST] error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

