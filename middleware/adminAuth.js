// middleware/adminAuth.js
// Admin-only JWT + guard middleware

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const IS_PROD = process.env.NODE_ENV === 'production';

// Admin login credentials (from env, with fallback)
export const ADMIN_USER = process.env.ADMIN_USER || 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

export function signAdminToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
}

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

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
}

export function setAdminCookie(res) {
  const token = signAdminToken();
  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 24 * 60 * 60 * 1000
  });
}

export function clearAdminCookie(res) {
  res.clearCookie('admin_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!process.env.COOKIE_SECURE
  });
}

export default {
  ADMIN_USER,
  ADMIN_PASSWORD,
  signAdminToken,
  adminRequired,
  setAdminCookie,
  clearAdminCookie
};
