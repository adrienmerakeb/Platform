// routes/services.js
// SERVICES FOR DASHBOARDS
// Uses `services` + `account_services` + /public/modules via servicesModules helpers

import express from 'express';
import { authRequired } from '../middleware/auth.js';
import { getServicesForAccount } from '../lib/servicesModules.js';

const router = express.Router();

/**
 * GET /api/services
 * Returns the list of services available to the currently logged-in account,
 * merged with filesystem modules info (manage/use pages).
 *
 * Response:
 * {
 *   role: "visitor" | "host" | "partner",
 *   services: [
 *     {
 *       service_key,
 *       display_name,
 *       icon_base,
 *       status,    // 'active' | 'suspended' | 'deleted' (filtered out)
 *       position,
 *       pages: {
 *         manage: [ { slug, label }, ... ],
 *         use:    [ { slug, label }, ... ]
 *       }
 *     },
 *     ...
 *   ]
 * }
 */
router.get('/services', authRequired, async (req, res) => {
  try {
    const role = req.user.role;
    const accountId = req.user.id;

    if (!accountId) {
      return res.status(400).json({ error: 'Missing account id' });
    }

    const services = await getServicesForAccount(role, accountId);
    res.json({ role, services });
  } catch (e) {
    console.error('/api/services error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
