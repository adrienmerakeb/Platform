// middleware/adminAuth.js
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './auth.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

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
    if (!raw) return res.status(401).json({ error: 'Admin auth required' });

    const tok = jwt.verify(raw, JWT_SECRET);
    if (tok.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
}

export { ADMIN_USER, ADMIN_PASSWORD };
