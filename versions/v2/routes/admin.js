// routes/admin.js
import { db } from '../config/db.js';
import { ADMIN_USER, ADMIN_PASSWORD, adminRequired, signAdminToken } from '../middleware/adminAuth.js';
import { hashPassword } from '../middleware/auth.js';

export function registerAdminRoutes(app) {
  // PASTE everything from:
  //   // ============ ADMIN MODERATION ============
  // plus:
  //   app.post('/api/admin/login', ...)
  //   app.post('/api/admin/logout', ...)
  //   app.delete('/api/admin/user', ...)
  //   app.delete('/api/admin/users/test/:role', ...)
  //   app.post('/api/admin/create-test', ...)
  //   app.get('/api/admin/users', ...)
  //   app.get('/api/admin/users/:role', ...)
  //   app.get/post/patch/delete '/api/admin/services...'
  //   app.post('/api/admin/account-services', ...)
  //   app.get('/api/admin/scan-modules', ...)
}
