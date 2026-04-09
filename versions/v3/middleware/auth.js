// middleware/auth.js
// Shared auth helpers: JWT, cookies, rate limiting, logging, password helpers

import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

import { getDB } from '../config/db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES = '7d';
const IS_PROD = process.env.NODE_ENV === 'production';

let db;
function ensureDB() {
  if (!db) db = getDB();
  return db;
}

// -----------------------------------------------------------------------------
// Rate limiter (used by authVisitor/authHost/authPartner)
// -----------------------------------------------------------------------------
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});

// -----------------------------------------------------------------------------
// Password helpers
// -----------------------------------------------------------------------------
export const hashPassword = (pwd) => bcrypt.hash(pwd, 10);
export const verifyPassword = (pwd, hash) => bcrypt.compare(pwd, hash);

// -----------------------------------------------------------------------------
// IP helper
// -----------------------------------------------------------------------------
export function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

// -----------------------------------------------------------------------------
// Connection logging helper
// -----------------------------------------------------------------------------
export async function safeLog({
  userId = null,
  provider,
  ip,
  success = 1
}) {
  try {
    const db = ensureDB();
    const uid = typeof userId === 'number' ? userId : null;
    await db.run(
      `INSERT INTO connection_logs (user_id, provider, ip, success)
       VALUES (?, ?, ?, ?)`,
      [uid, provider, ip, success]
    );
  } catch (err) {
    console.warn('Connection log failed:', err);
  }
}

// -----------------------------------------------------------------------------
// JWT helpers (visitor + orgs)
// -----------------------------------------------------------------------------
export function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role || 'visitor',
      status: user.status || 'V',
      has_guide_profile: !!user.has_guide_profile
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

export function setLoginCookie(res, user) {
  const token = signToken(user);
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

export function signTokenFromOrg(row, role) {
  return jwt.sign(
    {
      id: row.id,
      email: row.email,
      name: row.company_name,
      role,
      status: 'V',
      has_guide_profile: false
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

export function setOrgLoginCookie(res, row, role, remember = false) {
  const token = signTokenFromOrg(row, role);
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD
  };
  if (remember) cookieOpts.maxAge = 7 * 24 * 60 * 60 * 1000;
  res.cookie('token', token, cookieOpts);
}

// -----------------------------------------------------------------------------
// Auth middlewares
// -----------------------------------------------------------------------------
export function authRequired(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Simple role guard for host-only routes
export function hostRequired(req, res, next) {
  if (!req.user || req.user.role !== 'host') {
    return res.status(403).json({ error: 'Host role required' });
  }
  next();
}

// Helper for In-Time to get host id
export function getHostId(req) {
  if (req.user && req.user.role === 'host') return req.user.id;
  return null;
}
