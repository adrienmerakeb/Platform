// middleware/adminAuth.js
// Admin JWT + guard middleware

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const IS_PROD = process.env.NODE_ENV === 'production';

// Basic admin credentials from env (used in routes/admin.js)
export const ADMIN_USER = process.env.ADMIN_USER || 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

/**
 * Create a short-lived admin JWT.
 */
export function signAdminToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
}

/**
 * Middleware: require a valid admin token either in:
 *  - cookie `admin_token`, or
 *  - Authorization: Bearer <token>
 */
export function adminRequired(req, res, next) {
  try {
    const raw =
      req.cookies?.admin_token ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);

    if (!raw) {
      return res.status(401).json({ error: 'Admin auth required' });
    }

    const tok = jwt.verify(raw, JWT_SECRET);
    if (tok.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Optionally attach token payload
    req.admin = tok;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
}

/**
 * Helper to clear the admin cookie (used on logout route).
 */
export function clearAdminCookie(res) {
  res.clearCookie('admin_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD
  });
}
