// routes/misc.js
// Misc routes: ping, logout, dashboard, /api/me, /api/hosts

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { authRequired } from '../middleware/auth.js';
import { getDB } from '../config/db.js';

const router = express.Router();

const IS_PROD = process.env.NODE_ENV === 'production';

// Resolve project root and public dir (so this works no matter where it's mounted)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

let db;
function ensureDB() {
  if (!db) db = getDB();
  return db;
}

// -----------------------------------------------------------------------------
// Ping
// -----------------------------------------------------------------------------

// GET /api/ping
router.get('/api/ping', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// -----------------------------------------------------------------------------
// Logout
// -----------------------------------------------------------------------------

// POST /api/logout
router.post('/api/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD
  });
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Dashboard route (role-based)
// -----------------------------------------------------------------------------

// GET /dashboard
router.get('/dashboard', authRequired, (req, res) => {
  try {
    const role = req.user.role;
    if (role === 'host') {
      return res.sendFile(path.join(PUBLIC_DIR, 'pages/host/dashboard.html'));
    }
    if (role === 'partner') {
      return res.sendFile(
        path.join(PUBLIC_DIR, 'pages/partner/dashboard.html')
      );
    }
    // default = visitor
    return res.sendFile(
      path.join(PUBLIC_DIR, 'pages/visitor/dashboard.html')
    );
  } catch (e) {
    console.error('dashboard route error:', e);
    res.status(500).send('Server error');
  }
});

// -----------------------------------------------------------------------------
// Current user info (normalized)
// -----------------------------------------------------------------------------

// GET /api/me
router.get('/api/me', authRequired, async (req, res) => {
  const db = ensureDB();
  try {
    const role = req.user.role;

    if (role === 'visitor') {
      const row = await db.get(
        `SELECT id, name, email, role, status, has_guide_profile, created_at, suspended
         FROM users WHERE id = ?`,
        [req.user.id]
      );
      if (!row) return res.status(404).json({ error: 'User not found' });
      return res.json({ role, account: row });
    }

    if (role === 'host') {
      const row = await db.get(
        `SELECT id, company_name, email, host_type, selected_services, website, vat_id, created_at, suspended
         FROM hosts WHERE id = ?`,
        [req.user.id]
      );
      if (!row) return res.status(404).json({ error: 'Host not found' });
      return res.json({ role, account: row });
    }

    if (role === 'partner') {
      const row = await db.get(
        `SELECT id, company_name, email, website, vat_id, created_at, suspended
         FROM partners WHERE id = ?`,
        [req.user.id]
      );
      if (!row) return res.status(404).json({ error: 'Partner not found' });
      return res.json({ role, account: row });
    }

    return res.status(400).json({ error: 'Unknown role' });
  } catch (e) {
    console.error('/api/me error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// Simple hosts listing (same as original /api/hosts)
// -----------------------------------------------------------------------------

// GET /api/hosts
router.get('/api/hosts', async (_req, res) => {
  const db = ensureDB();
  try {
    const rows = await db.all(
      'SELECT id, company_name, email, host_type, selected_services, website, vat_id FROM hosts'
    );
    res.json(rows);
  } catch (e) {
    console.error('/api/hosts error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
