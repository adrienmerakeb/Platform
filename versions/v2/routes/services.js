// routes/services.js
import { db } from '../config/db.js';
import { scanModulesFromFS, upsertService } from '../lib/servicesModules.js';
import { authRequired } from '../middleware/auth.js';

export function registerServicesRoutes(app) {
  // Cut from server.js:
  // - the helper getServicesForAccount(...)
  // - route: app.get('/api/services', authRequired, ...)
}
