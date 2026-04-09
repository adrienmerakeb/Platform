// routes/misc.js
import path from 'path';
import { authRequired, IS_PROD } from '../middleware/auth.js';
import { db } from '../config/db.js';

export function registerMiscRoutes(app, PUBLIC_DIR) {
  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.post('/api/logout', (req, res) => {
    res.clearCookie('token', {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD
    });
    res.json({ ok: true });
  });

  app.get('/dashboard', authRequired, (req, res) => {
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
      return res.sendFile(
        path.join(PUBLIC_DIR, 'pages/visitor/dashboard.html')
      );
    } catch (e) {
      console.error('dashboard route error:', e);
      res.status(500).send('Server error');
    }
  });

  app.get('/api/me', authRequired, async (req, res) => {
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
        if (!row)
          return res.status(404).json({ error: 'Partner not found' });
        return res.json({ role, account: row });
      }

      return res.status(400).json({ error: 'Unknown role' });
    } catch (e) {
      console.error('/api/me error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/hosts', async (_req, res) => {
    const rows = await db.all(
      'SELECT id, company_name, email, host_type, selected_services, website, vat_id FROM hosts'
    );
    res.json(rows);
  });
}
