// routes/admin.js
// Admin login + moderation + services CRUD + module scan

import express from 'express';
import { getDB } from '../config/db.js';
import {
  ADMIN_USER,
  ADMIN_PASSWORD,
  signAdminToken,
  adminRequired,
  clearAdminCookie
} from '../middleware/adminAuth.js';
import { hashPassword } from '../middleware/auth.js';
import {
  upsertService,
  scanModulesFromFS,
  niceNameFromKey
} from '../lib/servicesModules.js';

const router = express.Router();

let db;
function ensureDB() {
  if (!db) db = getDB();
  return db;
}

// ============ ADMIN MODERATION ============

function normalizedTestMarkers() {
  return {
    emailRegex: /(\+test@)|(@.*\.test$)/i,
    namePrefix: '[TEST]'
  };
}

// -----------------------------------------------------------------------------
// Admin login / logout
// -----------------------------------------------------------------------------

// POST /api/admin/login
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing credentials' });
  }
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signAdminToken();
  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  });

  res.json({ ok: true });
});

// POST /api/admin/logout
router.post('/logout', (_req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Delete a single user by role + id/email
// -----------------------------------------------------------------------------

// DELETE /api/admin/user
router.delete('/user', adminRequired, async (req, res) => {
  const db = ensureDB();
  try {
    const { role, id, email } = req.body || {};
    if (!role || (!id && !email)) {
      return res.status(400).json({ error: 'Provide role and id OR email' });
    }
    const r = String(role).toLowerCase();

    let targetId = id || null;
    let targetEmail = email || null;

    // Resolve missing id/email for visitors
    if ((r === 'visitor' || r === 'users') && (!targetId || !targetEmail)) {
      const row = targetEmail
        ? await db.get('SELECT id, email FROM users WHERE email = ?', [targetEmail])
        : await db.get('SELECT id, email FROM users WHERE id = ?', [targetId]);
      if (!row) return res.status(404).json({ error: 'Visitor not found' });
      targetId = row.id;
      targetEmail = row.email;
    }

    // Hosts
    if ((r === 'host' || r === 'hosts') && (!targetId || !targetEmail)) {
      const row = targetEmail
        ? await db.get('SELECT id, email FROM hosts WHERE email = ?', [targetEmail])
        : await db.get('SELECT id, email FROM hosts WHERE id = ?', [targetId]);
      if (!row) return res.status(404).json({ error: 'Host not found' });
      targetId = row.id;
      targetEmail = row.email;
    }

    // Partners
    if ((r === 'partner' || r === 'partners') && (!targetId || !targetEmail)) {
      const row = targetEmail
        ? await db.get('SELECT id, email FROM partners WHERE email = ?', [targetEmail])
        : await db.get('SELECT id, email FROM partners WHERE id = ?', [targetId]);
      if (!row) return res.status(404).json({ error: 'Partner not found' });
      targetId = row.id;
      targetEmail = row.email;
    }

    // Perform delete by role
    if (r === 'visitor' || r === 'users') {
      await db.run('UPDATE connection_logs SET user_id = NULL WHERE user_id = ?', [
        targetId
      ]);
      await db.run('DELETE FROM reset_tokens WHERE email = ?', [targetEmail]);
      await db.run('DELETE FROM users WHERE id = ?', [targetId]);
      return res.json({ ok: true });
    }

    if (r === 'host' || r === 'hosts') {
      await db.run('DELETE FROM reset_tokens_host WHERE email = ?', [targetEmail]);
      await db.run('DELETE FROM hosts WHERE id = ?', [targetId]);
      return res.json({ ok: true });
    }

    if (r === 'partner' || r === 'partners') {
      await db.run('DELETE FROM reset_tokens_partner WHERE email = ?', [targetEmail]);
      await db.run('DELETE FROM partners WHERE id = ?', [targetId]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown role' });
  } catch (e) {
    console.error('admin delete user error', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// Bulk delete test users by role
// -----------------------------------------------------------------------------

// DELETE /api/admin/users/test/:role
router.delete('/users/test/:role', adminRequired, async (req, res) => {
  const db = ensureDB();
  try {
    const role = String(req.params.role || '').toLowerCase();
    const { emailRegex, namePrefix } = normalizedTestMarkers();

    let count = 0;

    async function delVisitors() {
      const rows = await db.all('SELECT id, email, name FROM users');
      const victims = rows.filter(
        (r) =>
          emailRegex.test(r.email || '') ||
          (r.name || '').startsWith(namePrefix)
      );
      for (const v of victims) {
        await db.run('UPDATE connection_logs SET user_id = NULL WHERE user_id = ?', [
          v.id
        ]);
        await db.run('DELETE FROM reset_tokens WHERE email = ?', [v.email]);
        await db.run('DELETE FROM users WHERE id = ?', [v.id]);
        count++;
      }
    }

    async function delHosts() {
      const rows = await db.all('SELECT id, email, company_name FROM hosts');
      const victims = rows.filter(
        (r) =>
          emailRegex.test(r.email || '') ||
          (r.company_name || '').startsWith(namePrefix)
      );
      for (const v of victims) {
        await db.run('DELETE FROM reset_tokens_host WHERE email = ?', [v.email]);
        await db.run('DELETE FROM hosts WHERE id = ?', [v.id]);
        count++;
      }
    }

    async function delPartners() {
      const rows = await db.all(
        'SELECT id, email, company_name FROM partners'
      );
      const victims = rows.filter(
        (r) =>
          emailRegex.test(r.email || '') ||
          (r.company_name || '').startsWith(namePrefix)
      );
      for (const v of victims) {
        await db.run('DELETE FROM reset_tokens_partner WHERE email = ?', [v.email]);
        await db.run('DELETE FROM partners WHERE id = ?', [v.id]);
        count++;
      }
    }

    if (role === 'visitor' || role === 'users' || role === 'all') await delVisitors();
    if (role === 'host' || role === 'hosts' || role === 'all') await delHosts();
    if (role === 'partner' || role === 'partners' || role === 'all')
      await delPartners();

    res.json({ ok: true, deleted: count });
  } catch (e) {
    console.error('admin bulk delete test users error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// Create test accounts for each role
// -----------------------------------------------------------------------------

// POST /api/admin/create-test
router.post('/create-test', adminRequired, async (req, res) => {
  const db = ensureDB();
  try {
    const {
      role,
      email,
      password,
      name,
      company_name,
      host_type = null,
      selected_services = [],
      website = null,
      vat_id = null
    } = req.body || {};

    if (!role || !email || !password) {
      return res.status(400).json({ error: 'role, email, password required' });
    }

    const r = String(role).toLowerCase();
    const hash = await hashPassword(password);
    const { emailRegex, namePrefix } = normalizedTestMarkers();

    let safeEmail = email;
    if (!emailRegex.test(email)) {
      const at = email.indexOf('@');
      if (at > 0) safeEmail = email.slice(0, at) + '+test' + email.slice(at);
    }

    // Visitor
    if (r === 'visitor' || r === 'users') {
      const displayName =
        name && name.startsWith(namePrefix)
          ? name
          : `${namePrefix} ${name || 'Visitor'}`;
      await db.run(
        `INSERT INTO users (name, email, password_hash, role, status, has_guide_profile)
         VALUES (?,?,?,?,?,?)`,
        [displayName, safeEmail, hash, 'visitor', 'V', 0]
      );
      return res.json({ ok: true });
    }

    // Host
    if (r === 'host' || r === 'hosts') {
      const company =
        company_name && company_name.startsWith(namePrefix)
          ? company_name
          : `${namePrefix} ${company_name || 'Host Co'}`;

      const services =
        Array.isArray(selected_services) && selected_services.length
          ? JSON.stringify(selected_services)
          : null;

      await db.run(
        `INSERT INTO hosts (company_name, email, password_hash, host_type, selected_services, website, vat_id)
         VALUES (?,?,?,?,?,?,?)`,
        [company, safeEmail, hash, host_type, services, website, vat_id]
      );
      return res.json({ ok: true });
    }

    // Partner
    if (r === 'partner' || r === 'partners') {
      const company =
        company_name && company_name.startsWith(namePrefix)
          ? company_name
          : `${namePrefix} ${company_name || 'Partner Co'}`;

      await db.run(
        `INSERT INTO partners (company_name, email, password_hash, website, vat_id)
         VALUES (?,?,?,?,?)`,
        [company, safeEmail, hash, website, vat_id]
      );
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown role' });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return res
        .status(409)
        .json({ error: 'Email already exists for that role' });
    }
    console.error('admin create test error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// Admin inspection: list all users grouped by role
// -----------------------------------------------------------------------------

// GET /api/admin/users
router.get('/users', adminRequired, async (_req, res) => {
  const db = ensureDB();
  try {
    const visitorRows = await db.all(`
      SELECT id, name, email, role, status, has_guide_profile, suspended, created_at
      FROM users
      ORDER BY created_at DESC
    `);

    const visitors = visitorRows.map((u) => ({
      ...u,
      services: 'In-Time; Let’s Get Out; My Events; Promos'
    }));

    const hostRows = await db.all(`
      SELECT id, company_name, email, host_type, selected_services, website, vat_id, suspended, created_at
      FROM hosts
      ORDER BY created_at DESC
    `);

    const hosts = hostRows.map((h) => {
      let svcText = '';
      if (h.selected_services) {
        try {
          const arr = JSON.parse(h.selected_services);
          if (Array.isArray(arr)) {
            svcText = arr.join('; ');
          } else {
            svcText = String(h.selected_services);
          }
        } catch {
          svcText = String(h.selected_services);
        }
      }
      return { ...h, services: svcText };
    });

    const partnerRows = await db.all(`
      SELECT id, company_name, email, website, vat_id, suspended, created_at
      FROM partners
      ORDER BY created_at DESC
    `);

    const partners = partnerRows.map((p) => ({
      ...p,
      services: 'Promos & Discounts'
    }));

    res.json({ visitors, hosts, partners });
  } catch (err) {
    console.error('Admin list failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/users/:role
router.get('/users/:role', adminRequired, async (req, res) => {
  const db = ensureDB();
  const role = String(req.params.role || '').toLowerCase();
  try {
    if (role === 'visitor' || role === 'users') {
      const rows = await db.all(`
        SELECT id, name, email, role, has_guide_profile, suspended, created_at, status
        FROM users ORDER BY created_at DESC
      `);
      return res.json(
        rows.map((r) => ({
          ...r,
          status: r.status ?? 'V'
        }))
      );
    }

    if (role === 'host' || role === 'hosts') {
      const rows = await db.all(`
        SELECT id, company_name, email, host_type, selected_services, website, vat_id, suspended, created_at
        FROM hosts ORDER BY created_at DESC
      `);
      return res.json(rows);
    }

    if (role === 'partner' || role === 'partners') {
      const rows = await db.all(`
        SELECT id, company_name, email, website, vat_id, suspended, created_at
        FROM partners ORDER BY created_at DESC
      `);
      return res.json(rows);
    }

    return res.status(400).json({ error: 'Unknown role' });
  } catch (err) {
    console.error('Admin list by role failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// Admin: services CRUD
// -----------------------------------------------------------------------------

// GET /api/admin/services
router.get('/services', adminRequired, async (_req, res) => {
  const db = ensureDB();
  try {
    const services = await db.all(`
      SELECT *
      FROM services
      ORDER BY position ASC, service_key ASC
    `);
    res.json({ services });
  } catch (e) {
    console.error('[admin/services] error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/services
router.post('/services', adminRequired, async (req, res) => {
  const db = ensureDB();
  try {
    const {
      service_key,
      display_name,
      icon_base = null,
      position = 100,
      status = 'active'
    } = req.body || {};
    if (!service_key || !display_name) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    await db.run(
      `
      INSERT INTO services(service_key, display_name, icon_base, position, status)
      VALUES (?,?,?,?,?)
      ON CONFLICT(service_key) DO UPDATE SET
        display_name=excluded.display_name,
        icon_base=excluded.icon_base,
        position=excluded.position,
        status=excluded.status
    `,
      [service_key, display_name, icon_base, position, status]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/admin/services/:service_key
router.patch('/services/:service_key', adminRequired, async (req, res) => {
  const db = ensureDB();
  try {
    const { position, status, display_name, icon_base } = req.body || {};
    const key = req.params.service_key;
    const row = await db.get('SELECT 1 FROM services WHERE service_key = ?', [
      key
    ]);
    if (!row) return res.status(404).json({ error: 'Service not found' });

    const sets = [];
    const vals = [];
    if (position != null) {
      sets.push('position = ?');
      vals.push(Number(position));
    }
    if (status) {
      sets.push('status = ?');
      vals.push(status);
    }
    if (display_name) {
      sets.push('display_name = ?');
      vals.push(display_name);
    }
    if (icon_base !== undefined) {
      sets.push('icon_base = ?');
      vals.push(icon_base);
    }

    if (!sets.length) return res.json({ ok: true });
    vals.push(key);
    await db.run(
      `UPDATE services SET ${sets.join(', ')} WHERE service_key = ?`,
      vals
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/services/:service_key
router.delete('/services/:service_key', adminRequired, async (req, res) => {
  const db = ensureDB();
  try {
    await db.run('DELETE FROM services WHERE service_key = ?', [
      req.params.service_key
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// Admin: account-services assign/suspend/remove
// -----------------------------------------------------------------------------

// POST /api/admin/account-services
router.post('/account-services', adminRequired, async (req, res) => {
  const db = ensureDB();
  try {
    const { role, account_id, service_key, action = 'assign' } = req.body || {};
    if (!role || !account_id || !service_key) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const roleNorm = String(role).toLowerCase();

    const svc = await db.get(
      'SELECT 1 FROM services WHERE service_key = ?',
      [service_key]
    );
    if (!svc) return res.status(404).json({ error: 'Unknown service_key' });

    if (action === 'assign') {
      await db.run(
        `INSERT INTO account_services(role, account_id, service_key, status)
         VALUES (?,?,?, 'active')
         ON CONFLICT(role, account_id, service_key)
         DO UPDATE SET status = 'active'`,
        [roleNorm, account_id, service_key]
      );
      return res.json({ ok: true });
    }

    if (action === 'suspend') {
      await db.run(
        `UPDATE account_services
         SET status = 'suspended'
         WHERE role = ? AND account_id = ? AND service_key = ?`,
        [roleNorm, account_id, service_key]
      );
      return res.json({ ok: true });
    }

    if (action === 'remove') {
      await db.run(
        `DELETE FROM account_services
         WHERE role = ? AND account_id = ? AND service_key = ?`,
        [roleNorm, account_id, service_key]
      );
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('account-services error', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// Filesystem scan for /public/modules → upsert into `services` table
// -----------------------------------------------------------------------------

// GET /api/admin/scan-modules
router.get('/scan-modules', adminRequired, async (_req, res) => {
  const db = ensureDB();
  try {
    // Use filesystem-based modules info + upsert positions sequentially
    const modules = await scanModulesFromFS();

    let maxPosRow = await db.get(
      `SELECT COALESCE(MAX(position), 0) AS maxp FROM services`
    );
    let nextPos = Number(maxPosRow?.maxp || 0) + 1;

    const out = [];
    for (const m of modules) {
      const display_name = niceNameFromKey(m.service_key);
      await upsertService({
        service_key: m.service_key,
        display_name,
        status: 'active',
        position: nextPos++,
        icon_base: m.icon_base || null
      });
      out.push({ service_key: m.service_key, display_name });
    }

    res.json({ ok: true, modules: out });
  } catch (e) {
    console.error('[scan-modules] error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
