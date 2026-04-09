// middleware/auth.js
// Shared auth + JWT helpers exactly matching the original server.js behaviour.

import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { getDb } from '../config/db.js';

dotenv.config();

/* -------------------------------------------------------------------------- */
/* CONSTANTS                                                                  */
/* -------------------------------------------------------------------------- */

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
export const JWT_EXPIRES = '7d';
export const IS_PROD = process.env.NODE_ENV === 'production';

/* -------------------------------------------------------------------------- */
/* PASSWORD HELPERS                                                           */
/* -------------------------------------------------------------------------- */

export const hashPassword = (pwd) => bcrypt.hash(pwd, 10);
export const verifyPassword = (pwd, hash) => bcrypt.compare(pwd, hash);

/* -------------------------------------------------------------------------- */
/* CLIENT IP                                                                  */
/* -------------------------------------------------------------------------- */

export function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

/* -------------------------------------------------------------------------- */
/* CONNECTION LOGS (safeLog)                                                  */
/* -------------------------------------------------------------------------- */

export async function safeLog({ userId = null, provider, ip, success = 1 }) {
  try {
    const db = getDb();
    const uid = (typeof userId === 'number') ? userId : null;
    await db.run(
      `INSERT INTO connection_logs (user_id, provider, ip, success)
       VALUES (?, ?, ?, ?)`,
      [uid, provider, ip, success]
    );
  } catch (err) {
    console.warn('Connection log failed:', err);
  }
}

/* -------------------------------------------------------------------------- */
/* JWT HELPERS (visitor + orgs)                                               */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* AUTH MIDDLEWARE                                                            */
/* -------------------------------------------------------------------------- */

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

// Host-only guard (for In-Time, host dashboards, etc.)
export function hostRequired(req, res, next) {
  if (!req.user || req.user.role !== 'host') {
    return res.status(403).json({ error: 'Host role required' });
  }
  next();
}

// *Optional* partner guard, in case any routes use it
export function partnerRequired(req, res, next) {
  if (!req.user || req.user.role !== 'partner') {
    return res.status(403).json({ error: 'Partner role required' });
  }
  next();
}

// Helper for In-Time to get host id
export function getHostId(req) {
  if (req.user && req.user.role === 'host') return req.user.id;
  return null;
}

/* -------------------------------------------------------------------------- */
/* RATE LIMITING (same as original)                                           */
/* -------------------------------------------------------------------------- */

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
