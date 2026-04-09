// routes/authVisitor.js
// VISITOR AUTH (local) + status + guide profile

import express from 'express';
import { getDB } from '../config/db.js';
import {
  authLimiter,
  hashPassword,
  verifyPassword,
  getClientIp,
  setLoginCookie,
  safeLog,
  authRequired
} from '../middleware/auth.js';

const router = express.Router();

let db;
function ensureDB() {
  if (!db) db = getDB();
  return db;
}

// -----------------------------------------------------------------------------
// VISITOR AUTH (local)
// -----------------------------------------------------------------------------

// POST /api/register
router.post('/register', authLimiter, async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);

  try {
    const { email, password, name = null, role = 'visitor' } = req.body || {};

    if (role !== 'visitor') {
      await safeLog({
        userId: null,
        provider: 'local-register',
        ip,
        success: 0
      });
      return res
        .status(400)
        .json({ error: 'Use the appropriate endpoint for this role' });
    }

    if (!email || !password) {
      await safeLog({
        userId: null,
        provider: 'local-register',
        ip,
        success: 0
      });
      return res.status(400).json({ error: 'Missing fields' });
    }

    const password_hash = await hashPassword(password);
    const result = await db.run(
      `INSERT INTO users (name, email, password_hash, role, status, has_guide_profile)
       VALUES (?,?,?,?,?,?)`,
      [name, email, password_hash, 'visitor', 'V', 0]
    );

    await safeLog({
      userId: result.lastID,
      provider: 'local-register',
      ip,
      success: 1
    });

    res.json({ ok: true });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      await safeLog({
        userId: null,
        provider: 'local-register',
        ip,
        success: 0
      });
      return res.status(409).json({ error: 'Email already in use' });
    }
    await safeLog({
      userId: null,
      provider: 'local-register',
      ip,
      success: 0
    });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/login
router.post('/login', authLimiter, async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);

  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      await safeLog({ userId: null, provider: 'local', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }

    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      await safeLog({ userId: null, provider: 'local', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (Number(user.suspended) === 1) {
      await safeLog({ userId: user.id, provider: 'local', ip, success: 0 });
      return res.status(403).json({
        error:
          'This account is currently suspended. Please contact abc@hotmail.com for more information.'
      });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      await safeLog({ userId: user.id, provider: 'local', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    setLoginCookie(res, user);
    await safeLog({ userId: user.id, provider: 'local', ip, success: 1 });
    res.json({ ok: true });
  } catch {
    await safeLog({ userId: null, provider: 'local', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/forgot
router.post('/forgot', authLimiter, async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);

  // sendResetMail is in config/mailer.js – import it there in your file if not yet:
  // import { sendResetMail } from '../config/mailer.js';
  // For this modular file to work, make sure you already have that import.
  const { sendResetMail } = await import('../config/mailer.js');

  try {
    const rawEmail = String(req.body?.email || '').trim();
    if (!rawEmail) {
      await safeLog({ provider: 'forgot', ip, success: 0 });
      return res.status(400).json({ error: 'Missing email' });
    }
    const email = rawEmail.toLowerCase();

    const user = await db.get('SELECT id FROM users WHERE LOWER(email) = ?', [
      email
    ]);
    if (!user) {
      // "Success" even if not found – don't leak existence
      await safeLog({ provider: 'forgot', ip, success: 1 });
      return res.json({ ok: true });
    }

    const token =
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await db.run(
      'INSERT INTO reset_tokens(email, token, expires_at) VALUES (?,?,?)',
      [email, token, expires]
    );

    const resetUrl = `${req.protocol}://${req.get(
      'host'
    )}/reset.html?token=${encodeURIComponent(
      token
    )}&email=${encodeURIComponent(email)}`;

    const { ok, info, error } = await sendResetMail({
      to: email,
      subject: 'Password reset',
      text: `Click to reset your password: ${resetUrl}`,
      html: `<p>Click to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
    });

    if (!ok) {
      console.warn('[MAIL visitors] send failed:', error);
      await safeLog({ provider: 'forgot', ip, success: 0 });
      return res.status(500).json({ error: 'Could not send reset link.' });
    }

    console.log(
      '[MAIL visitors] accepted=%j rejected=%j response=%s',
      info.accepted,
      info.rejected,
      info.response
    );
    console.log('[DEV ONLY] Visitor reset URL:', resetUrl);

    await safeLog({ provider: 'forgot', ip, success: 1 });
    res.json({
      ok: true,
      ...(process.env.NODE_ENV !== 'production' ? { resetUrl } : {})
    });
  } catch (e) {
    console.warn('[FORGOT visitors] error:', e?.message || e);
    await safeLog({ provider: 'forgot', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/reset
router.post('/reset', authLimiter, async (req, res) => {
  const db = ensureDB();
  const ip = getClientIp(req);

  try {
    const { email, token, newPassword } = req.body || {};
    const user = email
      ? await db.get('SELECT id FROM users WHERE email = ?', [email])
      : null;

    if (!email || !token || !newPassword) {
      await safeLog({
        userId: user?.id || null,
        provider: 'reset',
        ip,
        success: 0
      });
      return res.status(400).json({ error: 'Missing fields' });
    }

    const row = await db.get(
      'SELECT * FROM reset_tokens WHERE email = ? AND token = ?',
      [email, token]
    );
    if (!row) return res.status(400).json({ error: 'Bad token' });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Token expired' });
    }

    const password_hash = await hashPassword(newPassword);
    await db.run('UPDATE users SET password_hash = ? WHERE email = ?', [
      password_hash,
      email
    ]);
    await db.run('DELETE FROM reset_tokens WHERE email = ?', [email]);

    await safeLog({
      userId: user?.id || null,
      provider: 'reset',
      ip,
      success: 1
    });
    res.json({ ok: true });
  } catch {
    await safeLog({ userId: null, provider: 'reset', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// Status & Guide profile
// -----------------------------------------------------------------------------

// POST /api/status
router.post('/status', authRequired, async (req, res) => {
  const db = ensureDB();
  try {
    const { status } = req.body || {};
    const allowed = new Set(['V', 'G', 'VG']);
    if (!allowed.has(String(status))) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const u = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!u || u.role !== 'visitor') {
      return res
        .status(400)
        .json({ error: 'Status is for visitor accounts only' });
    }
    await db.run('UPDATE users SET status = ? WHERE id = ?', [
      String(status),
      req.user.id
    ]);
    const fresh = await db.get('SELECT * FROM users WHERE id = ?', [
      req.user.id
    ]);
    setLoginCookie(res, fresh);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/guide/create
router.post('/guide/create', authRequired, async (req, res) => {
  const db = ensureDB();
  try {
    const u = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!u || u.role !== 'visitor') {
      return res
        .status(400)
        .json({ error: 'Only visitor accounts can create guide profile' });
    }
    await db.run(
      'UPDATE users SET has_guide_profile = 1, status = ? WHERE id = ?',
      ['VG', req.user.id]
    );
    const fresh = await db.get('SELECT * FROM users WHERE id = ?', [
      req.user.id
    ]);
    setLoginCookie(res, fresh);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
