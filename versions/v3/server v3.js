// server.js — merged auth + services + In-Time (advanced queues) + OAuth providers

import express from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import AppleStrategy from 'passport-apple';
import FacebookStrategy from 'passport-facebook';
import TwitterStrategy from 'passport-twitter-oauth2';
import fs from 'fs/promises';
import crypto from 'crypto';
import QRCode from 'qrcode';

// ---- Env / paths ----
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'http://localhost:3000';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MODULES_ROOT = path.join(PUBLIC_DIR, 'modules');
const SERVICES_MAPPING_FILE = path.join(MODULES_ROOT, 'services-mapping.json');

// ---- App ----
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.static(PUBLIC_DIR));
app.use('/modules', express.static(MODULES_ROOT));

// Debug log for role APIs
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/host/')) {
    console.log('[HOST API]', req.method, req.path, 'CT:', req.headers['content-type']);
  }
  if (req.path.startsWith('/api/partner/')) {
    console.log('[PARTNER API]', req.method, req.path, 'CT:', req.headers['content-type']);
  }
  next();
});

// ---- Rate limit ----
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });

// ---- Small helpers ----
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES = '7d';
const IS_PROD = process.env.NODE_ENV === 'production';

const hashPassword = (pwd) => bcrypt.hash(pwd, 10);
const verifyPassword = (pwd, hash) => bcrypt.compare(pwd, hash);

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

const daysSince = (iso) => {
  const t = new Date(iso).getTime();
  if (!t) return 9999;
  return Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
};

function niceNameFromKey(k) {
  return String(k || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

let db; // set in DB init below

async function safeLog({ userId = null, provider, ip, success = 1 }) {
  try {
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

// ---- JWT (visitor + orgs) ----
function signToken(user) {
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

function setLoginCookie(res, user) {
  const token = signToken(user);
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function signTokenFromOrg(row, role) {
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

function setOrgLoginCookie(res, row, role, remember = false) {
  const token = signTokenFromOrg(row, role);
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD
  };
  if (remember) cookieOpts.maxAge = 7 * 24 * 60 * 60 * 1000;
  res.cookie('token', token, cookieOpts);
}

function authRequired(req, res, next) {
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
function hostRequired(req, res, next) {
  if (!req.user || req.user.role !== 'host') {
    return res.status(403).json({ error: 'Host role required' });
  }
  next();
}

// Helper for In-Time to get host id
function getHostId(req) {
  if (req.user && req.user.role === 'host') return req.user.id;
  return null;
}

// -----------------------------------------------------------------------------
// In-Time helpers (from script 1, adapted)
// -----------------------------------------------------------------------------
function toBoolInt(v) {
  return v ? 1 : 0;
}

function randomSlug(prefix = 'q') {
  const body = Math.random().toString(36).slice(2, 8);
  return `${prefix}${body}`;
}

// Generate AAA-BBB-CCC from letters + digits
function generateCode9() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  function block() {
    let s = '';
    for (let i = 0; i < 3; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }
  return `${block()}-${block()}-${block()}`;
}

async function generateUniqueCode9() {
  while (true) {
    const code = generateCode9();
    const existing = await db.get(
      'SELECT id FROM intime_bookings WHERE code9 = ?',
      code
    );
    if (!existing) return code;
  }
}

// Create the booking URL encoded into queue QR.
// For now we encode the visitor booking page:
//   /pages/visitor/VirtualQueueSpotBooking.html?queueId=...&venueId=...
function buildQueueQrPayload(queue) {
  const basePath = '/pages/visitor/VirtualQueueSpotBooking.html';
  const url = new URL(basePath, OAUTH_BASE_URL);
  url.searchParams.set('queueId', String(queue.id));
  url.searchParams.set('venueId', String(queue.id));
  if (queue.name) url.searchParams.set('name', queue.name);
  if (queue.location) url.searchParams.set('addr', queue.location);
  if (queue.gps_lat != null && queue.gps_lng != null) {
    url.searchParams.set('gps', `${queue.gps_lat},${queue.gps_lng}`);
  }
  return url.toString();
}

// -----------------------------------------------------------------------------
// DB init
// -----------------------------------------------------------------------------
(async () => {
  db = await open({
    filename: path.join(__dirname, 'auth.db'),
    driver: sqlite3.Database
  });

  const schemaSQL = `
PRAGMA foreign_keys = ON;

-- Visitors (users)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'visitor',
  status TEXT DEFAULT 'V',
  has_guide_profile INTEGER DEFAULT 0,
  provider TEXT,
  provider_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  suspended INTEGER NOT NULL DEFAULT 0
);

-- Visitor reset tokens
CREATE TABLE IF NOT EXISTS reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at DATETIME NOT NULL
);

-- Hosts
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  host_type TEXT,
  selected_services TEXT,
  website TEXT,
  vat_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  suspended INTEGER NOT NULL DEFAULT 0
);

-- Host reset tokens
CREATE TABLE IF NOT EXISTS reset_tokens_host (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at DATETIME NOT NULL
);

-- Partners
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  website TEXT,
  vat_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  suspended INTEGER NOT NULL DEFAULT 0
);

-- Partner reset tokens
CREATE TABLE IF NOT EXISTS reset_tokens_partner (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at DATETIME NOT NULL
);

-- Connection logs
CREATE TABLE IF NOT EXISTS connection_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  provider TEXT,
  ip TEXT,
  success INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ===== Service registry (admin-facing) =====
CREATE TABLE IF NOT EXISTS services (
  service_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  position INTEGER DEFAULT 100,
  icon_base TEXT
);

-- Which account (by role) has which service
CREATE TABLE IF NOT EXISTS account_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  service_key TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  UNIQUE(role, account_id, service_key)
);

-- ===== In-Time queues (host-owned, advanced schema) =====
CREATE TABLE IF NOT EXISTS intime_queues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER,
  name TEXT,
  location TEXT,
  gps_lat REAL,
  gps_lng REAL,

  queue_mode TEXT NOT NULL, -- 'live' | 'advance' | 'mixed'

  anon_booking_allowed INTEGER DEFAULT 0,
  requires_login INTEGER DEFAULT 0,
  requires_whitelist INTEGER DEFAULT 0,

  wave_capacity INTEGER,
  time_per_slot_minutes INTEGER,
  show_estimate INTEGER DEFAULT 0,

  mixed_patterns TEXT,       -- JSON array for mixed mode
  operating_days TEXT,       -- JSON array
  off_duty_periods TEXT,     -- JSON array

  calendar_sync_google INTEGER DEFAULT 0,
  calendar_sync_ms INTEGER DEFAULT 0,
  calendar_sync_other INTEGER DEFAULT 0,

  slug TEXT UNIQUE,          -- short id, used in URLs if needed
  qr_payload TEXT,           -- string encoded into the host QR code

  status TEXT DEFAULT 'active',
  valid_from DATETIME,
  valid_to DATETIME,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(host_id) REFERENCES hosts(id) ON DELETE SET NULL
);

-- Whitelist table (Only from my list)
CREATE TABLE IF NOT EXISTS intime_queue_allowed_visitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  UNIQUE(queue_id, email),
  FOREIGN KEY(queue_id) REFERENCES intime_queues(id) ON DELETE CASCADE
);

-- Bookings table (superset of both versions)
CREATE TABLE IF NOT EXISTS intime_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER NOT NULL,
  visitor_id INTEGER,
  visitor_email TEXT,
  visitor_name TEXT,

  code9 TEXT UNIQUE,          -- AAA-BBB-CCC
  short_code TEXT UNIQUE,     -- for future use if needed
  booking_token TEXT UNIQUE,  -- for token-based deep-links if needed

  status TEXT NOT NULL DEFAULT 'booked', -- 'booked' | 'redeemed' | 'cancelled' | 'expired'

  slot_date TEXT,             -- 'YYYY-MM-DD'
  slot_start TEXT,            -- 'HH:MM'
  slot_end TEXT,              -- 'HH:MM'
  slot_time DATETIME,         -- optional ISO datetime
  party_size INTEGER DEFAULT 1,
  source TEXT,                -- 'live' | 'advance'

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  redeemed_at DATETIME,
  redeem_host_id INTEGER,
  redeem_location TEXT,

  FOREIGN KEY(queue_id) REFERENCES intime_queues(id) ON DELETE CASCADE
);
`;

  await db.exec(schemaSQL);

  async function ensureColumn(table, column, ddl) {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    const exists = cols.some(c => String(c.name).toLowerCase() === column.toLowerCase());
    if (!exists) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      console.log(`[MIGRATION] ${table}.${column} added`);
    }
  }

  // Ensure certain columns exist if DB was created with an older schema
  await ensureColumn('users', 'suspended', 'suspended INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'status', "status TEXT DEFAULT 'V'");
  await ensureColumn('hosts', 'suspended', 'suspended INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('partners', 'suspended', 'suspended INTEGER NOT NULL DEFAULT 0');

  // Load service mapping at startup (host dashboards)
  await loadServiceMapping();
})().catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});

// -----------------------------------------------------------------------------
// Mailer
// -----------------------------------------------------------------------------
const useRealSmtp = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const transporter = nodemailer.createTransport(
  useRealSmtp
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        logger: true,
        debug: true
      }
    : { jsonTransport: true }
);

(async () => {
  try {
    await transporter.verify();
    console.log('[SMTP] transporter ready (real SMTP)');
  } catch (e) {
    if (transporter.options && transporter.options.jsonTransport) {
      console.log('[SMTP] jsonTransport active (DEV mode, emails logged to console)');
    } else {
      console.warn('[SMTP] verify() failed:', e?.message || e);
    }
  }
})();

async function sendResetMail({ to, subject, html, text }) {
  try {
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || 'no-reply@wanderpal.local',
      to, subject, html, text
    });
    return { ok: true, info };
  } catch (err) {
    console.warn('[SMTP] sendMail failed:', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

// Simple dev test endpoints
app.get('/api/dev/test-mail', async (req, res) => {
  try {
    const to = req.query.to || process.env.SMTP_USER;
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject: 'WanderPal SMTP test',
      text: 'If you receive this, SMTP sending works.',
      html: '<p>If you receive this, SMTP sending works.</p>'
    });
    return res.json({ ok: true, accepted: info.accepted, rejected: info.rejected, response: info.response });
  } catch (e) {
    console.error('[MAIL test] send failed:', e);
    return res.status(500).json({ error: 'Test send failed', detail: String(e?.message || e) });
  }
});

app.get('/api/dev/mail-test', async (_req, res) => {
  try {
    const to =
      process.env.MAIL_FROM?.match(/<(.+)>/)?.[1] ||
      process.env.MAIL_FROM ||
      process.env.SMTP_USER;
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject: 'WanderPal SMTP test',
      text: 'This is a test email.'
    });
    res.json({ ok: true, info: !!info });
  } catch (e) {
    console.error('Mail test failed:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ===== Admin auth helpers =====
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function signAdminToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
}

function adminRequired(req, res, next) {
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

// ============ ADMIN MODERATION ============

function normalizedTestMarkers() {
  return {
    emailRegex: /(\+test@)|(@.*\.test$)/i,
    namePrefix: '[TEST]',
  };
}

app.post('/api/admin/login', (req, res) => {
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
    secure: IS_PROD,
    maxAge: 24 * 60 * 60 * 1000
  });

  res.json({ ok: true });
});

app.post('/api/admin/logout', (_req, res) => {
  res.clearCookie('admin_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!process.env.COOKIE_SECURE
  });
  res.json({ ok: true });
});

app.delete('/api/admin/user', adminRequired, async (req, res) => {
  try {
    const { role, id, email } = req.body || {};
    if (!role || (!id && !email)) {
      return res.status(400).json({ error: 'Provide role and id OR email' });
    }
    const r = String(role).toLowerCase();

    let targetId = id || null;
    let targetEmail = email || null;

    if ((r === 'visitor' || r === 'users') && (!targetId || !targetEmail)) {
      const row = targetEmail
        ? await db.get('SELECT id, email FROM users WHERE email = ?', [targetEmail])
        : await db.get('SELECT id, email FROM users WHERE id = ?', [targetId]);
      if (!row) return res.status(404).json({ error: 'Visitor not found' });
      targetId = row.id;
      targetEmail = row.email;
    }
    if ((r === 'host' || r === 'hosts') && (!targetId || !targetEmail)) {
      const row = targetEmail
        ? await db.get('SELECT id, email FROM hosts WHERE email = ?', [targetEmail])
        : await db.get('SELECT id, email FROM hosts WHERE id = ?', [targetId]);
      if (!row) return res.status(404).json({ error: 'Host not found' });
      targetId = row.id;
      targetEmail = row.email;
    }
    if ((r === 'partner' || r === 'partners') && (!targetId || !targetEmail)) {
      const row = targetEmail
        ? await db.get('SELECT id, email FROM partners WHERE email = ?', [targetEmail])
        : await db.get('SELECT id, email FROM partners WHERE id = ?', [targetId]);
      if (!row) return res.status(404).json({ error: 'Partner not found' });
      targetId = row.id;
      targetEmail = row.email;
    }

    if (r === 'visitor' || r === 'users') {
      await db.run('UPDATE connection_logs SET user_id = NULL WHERE user_id = ?', [targetId]);
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

app.delete('/api/admin/users/test/:role', adminRequired, async (req, res) => {
  try {
    const role = String(req.params.role || '').toLowerCase();
    const { emailRegex, namePrefix } = normalizedTestMarkers();

    let count = 0;

    async function delVisitors() {
      const rows = await db.all('SELECT id, email, name FROM users');
      const victims = rows.filter(r =>
        emailRegex.test(r.email || '') || (r.name || '').startsWith(namePrefix)
      );
      for (const v of victims) {
        await db.run('UPDATE connection_logs SET user_id = NULL WHERE user_id = ?', [v.id]);
        await db.run('DELETE FROM reset_tokens WHERE email = ?', [v.email]);
        await db.run('DELETE FROM users WHERE id = ?', [v.id]);
        count++;
      }
    }

    async function delHosts() {
      const rows = await db.all('SELECT id, email, company_name FROM hosts');
      const victims = rows.filter(r =>
        emailRegex.test(r.email || '') || (r.company_name || '').startsWith(namePrefix)
      );
      for (const v of victims) {
        await db.run('DELETE FROM reset_tokens_host WHERE email = ?', [v.email]);
        await db.run('DELETE FROM hosts WHERE id = ?', [v.id]);
        count++;
      }
    }

    async function delPartners() {
      const rows = await db.all('SELECT id, email, company_name FROM partners');
      const victims = rows.filter(r =>
        emailRegex.test(r.email || '') || (r.company_name || '').startsWith(namePrefix)
      );
      for (const v of victims) {
        await db.run('DELETE FROM reset_tokens_partner WHERE email = ?', [v.email]);
        await db.run('DELETE FROM partners WHERE id = ?', [v.id]);
        count++;
      }
    }

    if (role === 'visitor' || role === 'users' || role === 'all') await delVisitors();
    if (role === 'host' || role === 'hosts' || role === 'all') await delHosts();
    if (role === 'partner' || role === 'partners' || role === 'all') await delPartners();

    res.json({ ok: true, deleted: count });
  } catch (e) {
    console.error('admin bulk delete test users error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/create-test', adminRequired, async (req, res) => {
  try {
    const {
      role, email, password,
      name, company_name,
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

    if (r === 'visitor' || r === 'users') {
      const displayName = (name && name.startsWith(namePrefix)) ? name : `${namePrefix} ${name || 'Visitor'}`;
      await db.run(
        `INSERT INTO users (name, email, password_hash, role, status, has_guide_profile)
         VALUES (?,?,?,?,?,?)`,
        [displayName, safeEmail, hash, 'visitor', 'V', 0]
      );
      return res.json({ ok: true });
    }

    if (r === 'host' || r === 'hosts') {
      const company = (company_name && company_name.startsWith(namePrefix))
        ? company_name
        : `${namePrefix} ${company_name || 'Host Co'}`;

      const services = Array.isArray(selected_services) && selected_services.length
        ? JSON.stringify(selected_services)
        : null;

      await db.run(
        `INSERT INTO hosts (company_name, email, password_hash, host_type, selected_services, website, vat_id)
         VALUES (?,?,?,?,?,?,?)`,
        [company, safeEmail, hash, host_type, services, website, vat_id]
      );
      return res.json({ ok: true });
    }

    if (r === 'partner' || r === 'partners') {
      const company = (company_name && company_name.startsWith(namePrefix))
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
      return res.status(409).json({ error: 'Email already exists for that role' });
    }
    console.error('admin create test error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- ADMIN INSPECTION ----
app.get('/api/admin/users', adminRequired, async (_req, res) => {
  try {
    const visitorRows = await db.all(`
      SELECT id, name, email, role, status, has_guide_profile, suspended, created_at
      FROM users
      ORDER BY created_at DESC
    `);

    const visitors = visitorRows.map(u => ({
      ...u,
      services: 'In-Time; Let’s Get Out; My Events; Promos'
    }));

    const hostRows = await db.all(`
      SELECT id, company_name, email, host_type, selected_services, website, vat_id, suspended, created_at
      FROM hosts
      ORDER BY created_at DESC
    `);

    const hosts = hostRows.map(h => {
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

    const partners = partnerRows.map(p => ({
      ...p,
      services: 'Promos & Discounts'
    }));

    res.json({ visitors, hosts, partners });
  } catch (err) {
    console.error('Admin list failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/users/:role', adminRequired, async (req, res) => {
  const role = String(req.params.role || '').toLowerCase();
  try {
    if (role === 'visitor' || role === 'users') {
      const rows = await db.all(`
        SELECT id, name, email, role, has_guide_profile, suspended, created_at, status
        FROM users ORDER BY created_at DESC
      `);
      return res.json(
        rows.map(r => ({
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

// === ADMIN: services CRUD ===
app.get('/api/admin/services', adminRequired, async (_req, res) => {
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

app.post('/api/admin/services', adminRequired, async (req, res) => {
  try {
    const { service_key, display_name, icon_base = null, position = 100, status = 'active' } = req.body || {};
    if (!service_key || !display_name) return res.status(400).json({ error: 'Missing fields' });

    await db.run(`
      INSERT INTO services(service_key, display_name, icon_base, position, status)
      VALUES (?,?,?,?,?)
      ON CONFLICT(service_key) DO UPDATE SET
        display_name=excluded.display_name,
        icon_base=excluded.icon_base,
        position=excluded.position,
        status=excluded.status
    `, [service_key, display_name, icon_base, position, status]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/services/:service_key', adminRequired, async (req, res) => {
  try {
    const { position, status, display_name, icon_base } = req.body || {};
    const key = req.params.service_key;
    const row = await db.get('SELECT 1 FROM services WHERE service_key = ?', [key]);
    if (!row) return res.status(404).json({ error: 'Service not found' });

    const sets = [];
    const vals = [];
    if (position != null) { sets.push('position = ?'); vals.push(Number(position)); }
    if (status) { sets.push('status = ?'); vals.push(status); }
    if (display_name) { sets.push('display_name = ?'); vals.push(display_name); }
    if (icon_base !== undefined) { sets.push('icon_base = ?'); vals.push(icon_base); }

    if (!sets.length) return res.json({ ok: true });
    vals.push(key);
    await db.run(`UPDATE services SET ${sets.join(', ')} WHERE service_key = ?`, vals);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/services/:service_key', adminRequired, async (req, res) => {
  try {
    await db.run('DELETE FROM services WHERE service_key = ?', [req.params.service_key]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/account-services', adminRequired, async (req, res) => {
  try {
    const { role, account_id, service_key, action = 'assign' } = req.body || {};
    if (!role || !account_id || !service_key) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const roleNorm = String(role).toLowerCase();

    const svc = await db.get('SELECT 1 FROM services WHERE service_key = ?', [service_key]);
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

// Filesystem scan for /public/modules → upsert in `services` table
app.get('/api/admin/scan-modules', adminRequired, async (_req, res) => {
  try {
    const root = MODULES_ROOT;

    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (e) {
      return res.json({ ok: true, modules: [], note: 'No /public/modules directory found' });
    }

    const maxPosRow = await db.get(`SELECT COALESCE(MAX(position), 0) AS maxp FROM services`);
    let nextPos = Number(maxPosRow?.maxp || 0) + 1;

    const modules = [];
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const key = d.name;
      const display_name = niceNameFromKey(key);
      await upsertService({
        service_key: key,
        display_name,
        status: 'active',
        position: nextPos++
      });
      modules.push({ service_key: key, display_name });
    }

    res.json({ ok: true, modules });
  } catch (e) {
    console.error('[scan-modules] error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

async function upsertService({ service_key, display_name, status = 'active', position = 0, icon_base = null }) {
  await db.run(
    `INSERT INTO services(service_key, display_name, status, position, icon_base)
     VALUES (?,?,?,?,?)
     ON CONFLICT(service_key) DO UPDATE SET
       display_name = excluded.display_name,
       status       = COALESCE(excluded.status, services.status),
       position     = COALESCE(excluded.position, services.position),
       icon_base    = COALESCE(excluded.icon_base, services.icon_base)
    `,
    [service_key, display_name, status, position, icon_base]
  );
}

// -----------------------------------------------------------------------------
// Filesystem helpers for /public/modules + service-mapping
// -----------------------------------------------------------------------------

async function loadBaseJson(serviceKey, mode) {
  const basePath = path.join(MODULES_ROOT, serviceKey, mode, 'base.json');
  try {
    const raw = await fs.readFile(basePath, 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : {};
  } catch (err) {
    console.warn(`[modules] base.json missing/invalid for ${serviceKey}/${mode}:`, err.message || err);
    return {};
  }
}

function buildPagesFromBase(serviceKey, mode, baseJson) {
  const pages = [];
  const entries = Object.entries(baseJson || {});

  const mainEntry = entries.find(([k]) => k.trim().toLowerCase() === 'main');
  if (mainEntry && mainEntry[1]) {
    pages.push({
      slug: 'main.html',
      label: String(mainEntry[1])
    });
  }

  const pageEntries = entries.filter(([k]) => /^page\s+\d+$/i.test(k.trim()));
  pageEntries
    .sort((a, b) => {
      const na = parseInt(a[0].replace(/[^\d]/g, ''), 10) || 0;
      const nb = parseInt(b[0].replace(/[^\d]/g, ''), 10) || 0;
      return na - nb;
    })
    .forEach(([key, label]) => {
      if (!label) return;
      const slugBase = key.trim().toLowerCase();
      const encoded = encodeURIComponent(slugBase);
      pages.push({
        slug: `${encoded}.html`,
        label: String(label)
      });
    });

  return pages;
}

async function findIconBase(serviceKey) {
  const iconsDir = path.join(MODULES_ROOT, serviceKey, 'icons');
  try {
    const files = await fs.readdir(iconsDir);
    const off =
      files.find(f => /-off\.png$/i.test(f)) ||
      files.find(f => /\.png$/i.test(f));
    if (!off) return null;
    const publicPath = `/modules/${serviceKey}/icons/${off}`;
    return publicPath.replace(/-off\.png$/i, '').replace(/\.png$/i, '');
  } catch {
    return null;
  }
}

async function scanModulesFromFS() {
  let entries;
  try {
    entries = await fs.readdir(MODULES_ROOT, { withFileTypes: true });
  } catch (err) {
    console.warn('[modules] failed to read modules folder:', err.message || err);
    return [];
  }

  const modules = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const key = d.name;

    const manageBase = await loadBaseJson(key, 'manage');
    const useBase = await loadBaseJson(key, 'use');

    const managePages = buildPagesFromBase(key, 'manage', manageBase);
    const usePages = buildPagesFromBase(key, 'use', useBase);

    const display_name =
      (manageBase && manageBase.main) ||
      (useBase && useBase.main) ||
      niceNameFromKey(key);

    const icon_base = await findIconBase(key);

    modules.push({
      service_key: key,
      display_name,
      icon_base,
      position: 0,
      managePages,
      usePages
    });
  }

  return modules;
}

// ---- Services mapping (A11 → "In-Time", etc.) ----
let SERVICE_CODE_TO_MODULE = Object.create(null);
let SERVICE_LABEL_TO_CODE = Object.create(null);

function canon(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

async function loadServiceMapping() {
  try {
    const raw = await fs.readFile(SERVICES_MAPPING_FILE, 'utf8');
    const json = JSON.parse(raw);

    SERVICE_CODE_TO_MODULE = json;
    SERVICE_LABEL_TO_CODE = Object.create(null);

    for (const [code, cfg] of Object.entries(json)) {
      if (cfg.label) {
        SERVICE_LABEL_TO_CODE[canon(cfg.label)] = {
          code,
          module_key: cfg.module_key,
          display_name: cfg.display_name || cfg.module_key || cfg.label
        };
      }
    }

    console.log('[services-mapping] loaded', Object.keys(SERVICE_CODE_TO_MODULE).length, 'entries');
  } catch (e) {
    console.warn('[services-mapping] load failed:', e.message || e);
    SERVICE_CODE_TO_MODULE = Object.create(null);
    SERVICE_LABEL_TO_CODE = Object.create(null);
  }
}

// -----------------------------------------------------------------------------
// VISITOR AUTH (local)
// -----------------------------------------------------------------------------
app.post('/api/register', authLimiter, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const { email, password, name = null, role = 'visitor' } = req.body || {};
    if (role !== 'visitor') {
      await safeLog({ userId: null, provider: 'local-register', ip, success: 0 });
      return res.status(400).json({ error: 'Use the appropriate endpoint for this role' });
    }
    if (!email || !password) {
      await safeLog({ userId: null, provider: 'local-register', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }
    const password_hash = await hashPassword(password);
    const result = await db.run(
      `INSERT INTO users (name, email, password_hash, role, status, has_guide_profile)
       VALUES (?,?,?,?,?,?)`,
      [name, email, password_hash, 'visitor', 'V', 0]
    );
    await safeLog({ userId: result.lastID, provider: 'local-register', ip, success: 1 });
    res.json({ ok: true });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      await safeLog({ userId: null, provider: 'local-register', ip, success: 0 });
      return res.status(409).json({ error: 'Email already in use' });
    }
    await safeLog({ userId: null, provider: 'local-register', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      await safeLog({ userId: null, provider: 'local', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }

    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      await safeLog({ userId: null, provider: 'local', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (Number(user.suspended) === 1) {
      await safeLog({ userId: user.id, provider: 'local', ip, success: 0 });
      return res.status(403).json({
        error: 'This account is currently suspended. Please contact abc@hotmail.com for more information.'
      });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      await safeLog({ userId: user.id, provider: 'local', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    setLoginCookie(res, user);
    await safeLog({ userId: user.id, provider: 'local', ip, success: 1 });
    res.json({ ok: true });
  } catch {
    await safeLog({ userId: null, provider: 'local', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/forgot', authLimiter, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const rawEmail = String(req.body?.email || '').trim();
    if (!rawEmail) {
      await safeLog({ provider: 'forgot', ip, success: 0 });
      return res.status(400).json({ error: 'Missing email' });
    }
    const email = rawEmail.toLowerCase();

    const user = await db.get('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
    if (!user) {
      await safeLog({ provider: 'forgot', ip, success: 1 });
      return res.json({ ok: true });
    }

    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await db.run('INSERT INTO reset_tokens(email, token, expires_at) VALUES (?,?,?)', [email, token, expires]);

    const resetUrl = `${req.protocol}://${req.get('host')}/reset.html?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

    const { ok, info, error } = await sendResetMail({
      to: email,
      subject: 'Password reset',
      text: `Click to reset your password: ${resetUrl}`,
      html: `<p>Click to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
    });

    if (!ok) {
      console.warn('[MAIL visitors] send failed:', error);
      await safeLog({ provider: 'forgot', ip, success: 0 });
      return res.status(500).json({ error: 'Could not send reset link.' });
    }

    console.log('[MAIL visitors] accepted=%j rejected=%j response=%s', info.accepted, info.rejected, info.response);
    console.log('[DEV ONLY] Visitor reset URL:', resetUrl);

    await safeLog({ provider: 'forgot', ip, success: 1 });
    res.json({ ok: true, ...(process.env.NODE_ENV !== 'production' ? { resetUrl } : {}) });
  } catch (e) {
    console.warn('[FORGOT visitors] error:', e?.message || e);
    await safeLog({ provider: 'forgot', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/reset', authLimiter, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const { email, token, newPassword } = req.body || {};
    const user = email ? await db.get('SELECT id FROM users WHERE email = ?', [email]) : null;
    if (!email || !token || !newPassword) {
      await safeLog({ userId: user?.id || null, provider: 'reset', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }
    const row = await db.get('SELECT * FROM reset_tokens WHERE email = ? AND token = ?', [email, token]);
    if (!row) return res.status(400).json({ error: 'Bad token' });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Token expired' });
    const password_hash = await hashPassword(newPassword);
    await db.run('UPDATE users SET password_hash = ? WHERE email = ?', [password_hash, email]);
    await db.run('DELETE FROM reset_tokens WHERE email = ?', [email]);
    await safeLog({ userId: user?.id || null, provider: 'reset', ip, success: 1 });
    res.json({ ok: true });
  } catch {
    await safeLog({ userId: null, provider: 'reset', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/status', authRequired, async (req, res) => {
  try {
    const { status } = req.body || {};
    const allowed = new Set(['V', 'G', 'VG']);
    if (!allowed.has(String(status))) return res.status(400).json({ error: 'Invalid status' });
    const u = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!u || u.role !== 'visitor') return res.status(400).json({ error: 'Status is for visitor accounts only' });
    await db.run('UPDATE users SET status = ? WHERE id = ?', [String(status), req.user.id]);
    const fresh = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    setLoginCookie(res, fresh);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/guide/create', authRequired, async (req, res) => {
  try {
    const u = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!u || u.role !== 'visitor') return res.status(400).json({ error: 'Only visitor accounts can create guide profile' });
    await db.run('UPDATE users SET has_guide_profile = 1, status = ? WHERE id = ?', ['VG', req.user.id]);
    const fresh = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    setLoginCookie(res, fresh);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------- HOST AUTH ----------------
app.post('/api/host/register', authLimiter, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const {
      company_name, email, password,
      host_type = null,
      selected_services = [],
      website = null, vat_id = null
    } = req.body || {};

    if (!company_name || !email || !password) {
      await safeLog({ userId: null, provider: 'host-register', ip, success: 0 });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const password_hash = await hashPassword(password);
    const services = Array.isArray(selected_services) && selected_services.length
      ? JSON.stringify(selected_services)
      : null;

    await db.run(
      `INSERT INTO hosts (company_name, email, password_hash, host_type, selected_services, website, vat_id)
       VALUES (?,?,?,?,?,?,?)`,
      [company_name, email, password_hash, host_type, services, website, vat_id]
    );

    await safeLog({ userId: null, provider: 'host-register', ip, success: 1 });
    res.json({ ok: true });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      await safeLog({ userId: null, provider: 'host-register', ip, success: 0 });
      return res.status(409).json({ error: 'Email already in use for hosts' });
    }
    await safeLog({ userId: null, provider: 'host-register', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/host/login', authLimiter, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const { company_name, email, password, remember = false } = req.body || {};
    if (!company_name || !email || !password) {
      await safeLog({ userId: null, provider: 'host', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }

    const row = await db.get('SELECT * FROM hosts WHERE email = ?', [email]);
    if (!row) {
      await safeLog({ userId: null, provider: 'host', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (row.company_name.trim().toLowerCase() !== company_name.trim().toLowerCase()) {
      await safeLog({ userId: null, provider: 'host', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid company or credentials' });
    }

    if (Number(row.suspended) === 1) {
      await safeLog({ userId: null, provider: 'host', ip, success: 0 });
      return res.status(403).json({
        error: 'This host account has been suspended. Please contact abc@hotmail.com for assistance.'
      });
    }

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      await safeLog({ userId: null, provider: 'host', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid company or credentials' });
    }

    setOrgLoginCookie(res, row, 'host', !!remember);
    await safeLog({ userId: null, provider: 'host', ip, success: 1 });
    res.json({ ok: true });
  } catch {
    await safeLog({ userId: null, provider: 'host', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/host/forgot', async (req, res) => {
  const ip = getClientIp(req);
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      await safeLog({ provider: 'host-forgot', ip, success: 0 });
      return res.status(400).json({ error: 'Missing email' });
    }

    const host = await db.get(`SELECT id, email FROM hosts WHERE LOWER(email) = ?`, [email]);
    if (!host) {
      await safeLog({ provider: 'host-forgot', ip, success: 1 });
      return res.json({ ok: true });
    }

    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const expires = new Date(Date.now() + 1000 * 60 * 30).toISOString();

    await db.run(
      `INSERT INTO reset_tokens_host (email, token, expires_at) VALUES (?, ?, ?)`,
      [email, token, expires]
    );

    const resetUrl = `${OAUTH_BASE_URL}/host-reset.html?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

    const r = await sendResetMail({
      to: email,
      subject: 'Reset your Host password',
      text: `Reset your password: ${resetUrl}`,
      html: `<p>Reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
    });

    if (!r.ok) {
      await safeLog({ provider: 'host-forgot', ip, success: 0 });
      return res.status(500).json({ error: 'Could not send reset link.' });
    }

    await safeLog({ provider: 'host-forgot', ip, success: 1 });
    const dev = process.env.NODE_ENV !== 'production';
    return res.json({ ok: true, ...(dev ? { dev: true, resetUrl } : {}) });
  } catch (e) {
    console.error('[HOST FORGOT] error:', e);
    await safeLog({ provider: 'host-forgot', ip, success: 0 });
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/host/reset', async (req, res) => {
  const ip = getClientIp(req);
  const { token, email } = req.body || {};
  const pwd = (req.body && (req.body.password || req.body.newPassword)) || '';
  try {
    if (!token || !email || !pwd) {
      await safeLog({ provider: 'host-reset', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }
    const em = String(email).trim().toLowerCase();

    const row = await db.get(
      `SELECT * FROM reset_tokens_host
       WHERE token = ? AND LOWER(email) = ? AND expires_at > CURRENT_TIMESTAMP`,
      [token, em]
    );
    if (!row) {
      await safeLog({ provider: 'host-reset', ip, success: 0 });
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const hash = await hashPassword(pwd);
    const upd = await db.run(`UPDATE hosts SET password_hash = ? WHERE LOWER(email) = ?`, [hash, em]);
    if (upd.changes === 0) {
      await safeLog({ provider: 'host-reset', ip, success: 0 });
      return res.status(404).json({ error: 'Account not found' });
    }

    await db.run(`DELETE FROM reset_tokens_host WHERE token = ?`, [token]);
    await safeLog({ provider: 'host-reset', ip, success: 1 });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[HOST RESET] error:', e);
    await safeLog({ provider: 'host-reset', ip, success: 0 });
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------------- PARTNER AUTH ----------------
app.post('/api/partner/register', authLimiter, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const { company_name, email, password, website = null, vat_id = null } = req.body || {};
    if (!company_name || !email || !password) {
      await safeLog({ userId: null, provider: 'partner-register', ip, success: 0 });
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const password_hash = await hashPassword(password);
    await db.run(
      `INSERT INTO partners (company_name, email, password_hash, website, vat_id)
       VALUES (?,?,?,?,?)`,
      [company_name, email, password_hash, website, vat_id]
    );
    await safeLog({ userId: null, provider: 'partner-register', ip, success: 1 });
    res.json({ ok: true });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      await safeLog({ userId: null, provider: 'partner-register', ip, success: 0 });
      return res.status(409).json({ error: 'Email already in use for partners' });
    }
    await safeLog({ userId: null, provider: 'partner-register', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/partner/login', authLimiter, async (req, res) => {
  const ip = getClientIp(req);
  try {
    const { company_name, email, password, remember = false } = req.body || {};
    if (!company_name || !email || !password) {
      await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }

    const row = await db.get('SELECT * FROM partners WHERE email = ?', [email]);
    if (!row) {
      await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (row.company_name.trim().toLowerCase() !== company_name.trim().toLowerCase()) {
      await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid company or credentials' });
    }

    if (Number(row.suspended) === 1) {
      await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
      return res.status(403).json({
        error: 'This partner account has been suspended. Please contact abc@hotmail.com for more information.'
      });
    }

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
      return res.status(401).json({ error: 'Invalid company or credentials' });
    }

    setOrgLoginCookie(res, row, 'partner', !!remember);
    await safeLog({ userId: null, provider: 'partner', ip, success: 1 });
    res.json({ ok: true });
  } catch {
    await safeLog({ userId: null, provider: 'partner', ip, success: 0 });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/partner/forgot', async (req, res) => {
  const ip = getClientIp(req);
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      await safeLog({ provider: 'partner-forgot', ip, success: 0 });
      return res.status(400).json({ error: 'Missing email' });
    }

    const partner = await db.get(`SELECT id, email FROM partners WHERE LOWER(email) = ?`, [email]);

    if (!partner) {
      await safeLog({ provider: 'partner-forgot', ip, success: 1 });
      return res.json({ ok: true });
    }

    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const expires = new Date(Date.now() + 1000 * 60 * 30).toISOString();

    await db.run(
      `INSERT INTO reset_tokens_partner (email, token, expires_at) VALUES (?, ?, ?)`,
      [email, token, expires]
    );

    const resetUrl = `${OAUTH_BASE_URL}/partner-reset.html?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

    const r = await sendResetMail({
      to: email,
      subject: 'Reset your Partner password',
      text: `Reset your password: ${resetUrl}`,
      html: `<p>Reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
    });

    if (!r.ok) {
      await safeLog({ provider: 'partner-forgot', ip, success: 0 });
      return res.status(500).json({ error: 'Could not send reset link.' });
    }

    await safeLog({ provider: 'partner-forgot', ip, success: 1 });
    const dev = process.env.NODE_ENV !== 'production';
    return res.json({ ok: true, ...(dev ? { dev: true, resetUrl } : {}) });
  } catch (e) {
    console.error('[PARTNER FORGOT] error:', e);
    await safeLog({ provider: 'partner-forgot', ip, success: 0 });
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/partner/reset', async (req, res) => {
  const ip = getClientIp(req);
  const { token, email } = req.body || {};
  const pwd = (req.body && (req.body.password || req.body.newPassword)) || '';
  try {
    if (!token || !email || !pwd) {
      await safeLog({ provider: 'partner-reset', ip, success: 0 });
      return res.status(400).json({ error: 'Missing fields' });
    }
    const em = String(email).trim().toLowerCase();

    const row = await db.get(
      `SELECT * FROM reset_tokens_partner
       WHERE token = ? AND LOWER(email) = ? AND expires_at > CURRENT_TIMESTAMP`,
      [token, em]
    );
    if (!row) {
      await safeLog({ provider: 'partner-reset', ip, success: 0 });
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const hash = await hashPassword(pwd);
    const upd = await db.run(`UPDATE partners SET password_hash = ? WHERE LOWER(email) = ?`, [hash, em]);
    if (upd.changes === 0) {
      await safeLog({ provider: 'partner-reset', ip, success: 0 });
      return res.status(404).json({ error: 'Account not found' });
    }

    await db.run(`DELETE FROM reset_tokens_partner WHERE token = ?`, [token]);
    await safeLog({ provider: 'partner-reset', ip, success: 1 });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[PARTNER RESET] error:', e);
    await safeLog({ provider: 'partner-reset', ip, success: 0 });
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/hosts', async (_req, res) => {
  const rows = await db.all('SELECT id, company_name, email, host_type, selected_services, website, vat_id FROM hosts');
  res.json(rows);
});

// -----------------------------------------------------------------------------
// OAUTH (VISITOR) – Google, Apple, Facebook, Twitter
// -----------------------------------------------------------------------------
app.use(passport.initialize());

async function findOrCreateOAuthUser({ provider, providerId, email, name }) {
  const prov = String(provider || '').toLowerCase();
  const pid = String(providerId || '');

  let user = await db.get(
    'SELECT * FROM users WHERE provider = ? AND provider_id = ?',
    [prov, pid]
  );

  if (!user && email) {
    user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  }

  if (user) {
    if (!user.provider || !user.provider_id) {
      await db.run(
        'UPDATE users SET provider = ?, provider_id = ? WHERE id = ?',
        [prov, pid, user.id]
      );
      user = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
    }
    return user;
  }

  const randomHash = await hashPassword(crypto.randomBytes(16).toString('hex'));
  const displayName = name || email || `${prov} user`;

  const result = await db.run(
    `INSERT INTO users (name, email, password_hash, role, status, has_guide_profile, provider, provider_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      displayName,
      email || `${pid}@${prov}.oauth.local`,
      randomHash,
      'visitor',
      'V',
      0,
      prov,
      pid
    ]
  );

  const newUser = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
  return newUser;
}

// --- Google ---
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${OAUTH_BASE_URL}/auth/google/callback`
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value || null;
        const name = profile.displayName || profile.name?.givenName || null;
        const user = await findOrCreateOAuthUser({
          provider: 'google',
          providerId: profile.id,
          email,
          name
        });
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));

  app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'], session: false })
  );

  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/?login=failed', session: false }),
    async (req, res) => {
      const ip = getClientIp(req);
      const user = req.user;
      setLoginCookie(res, user);
      await safeLog({ userId: user.id, provider: 'google-oauth', ip, success: 1 });
      res.redirect('/dashboard');
    }
  );
} else {
  console.log('[OAuth] Google not configured (missing env vars).');
}

// --- Apple ---
if (
  process.env.APPLE_CLIENT_ID &&
  process.env.APPLE_TEAM_ID &&
  process.env.APPLE_KEY_ID &&
  process.env.APPLE_PRIVATE_KEY
) {
  passport.use(new AppleStrategy(
    {
      clientID: process.env.APPLE_CLIENT_ID,
      teamID: process.env.APPLE_TEAM_ID,
      keyID: process.env.APPLE_KEY_ID,
      privateKeyString: process.env.APPLE_PRIVATE_KEY,
      callbackURL: `${OAUTH_BASE_URL}/auth/apple/callback`
    },
    async (accessToken, refreshToken, idToken, profile, done) => {
      try {
        const email = profile?.email || idToken?.email || null;
        const name = profile?.name || null;
        const user = await findOrCreateOAuthUser({
          provider: 'apple',
          providerId: profile?.id || idToken?.sub || 'unknown',
          email,
          name
        });
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));

  app.get('/auth/apple',
    passport.authenticate('apple', { scope: ['name', 'email'], session: false })
  );

  app.post('/auth/apple/callback',
    passport.authenticate('apple', { failureRedirect: '/?login=failed', session: false }),
    async (req, res) => {
      const ip = getClientIp(req);
      const user = req.user;
      setLoginCookie(res, user);
      await safeLog({ userId: user.id, provider: 'apple-oauth', ip, success: 1 });
      res.redirect('/dashboard');
    }
  );
} else {
  console.log('[OAuth] Apple not configured (missing env vars).');
}

// --- Facebook ---
if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
  passport.use(new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_CLIENT_ID,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
      callbackURL: `${OAUTH_BASE_URL}/auth/facebook/callback`,
      profileFields: ['id', 'displayName', 'emails']
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value || null;
        const name = profile.displayName || null;
        const user = await findOrCreateOAuthUser({
          provider: 'facebook',
          providerId: profile.id,
          email,
          name
        });
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));

  app.get('/auth/facebook',
    passport.authenticate('facebook', { scope: ['email'], session: false })
  );

  app.get('/auth/facebook/callback',
    passport.authenticate('facebook', { failureRedirect: '/?login=failed', session: false }),
    async (req, res) => {
      const ip = getClientIp(req);
      const user = req.user;
      setLoginCookie(res, user);
      await safeLog({ userId: user.id, provider: 'facebook-oauth', ip, success: 1 });
      res.redirect('/dashboard');
    }
  );
} else {
  console.log('[OAuth] Facebook not configured (missing env vars).');
}

// --- Twitter (OAuth2) ---
if (process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET) {
  passport.use(new TwitterStrategy(
    {
      clientID: process.env.TWITTER_CLIENT_ID,
      clientSecret: process.env.TWITTER_CLIENT_SECRET,
      callbackURL: `${OAUTH_BASE_URL}/auth/twitter/callback`,
      scope: ['tweet.read', 'users.read']
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value || null;
        const name = profile.displayName || profile.username || null;
        const user = await findOrCreateOAuthUser({
          provider: 'twitter',
          providerId: profile.id,
          email,
          name
        });
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));

  app.get('/auth/twitter',
    passport.authenticate('twitter', { session: false })
  );

  app.get('/auth/twitter/callback',
    passport.authenticate('twitter', { failureRedirect: '/?login=failed', session: false }),
    async (req, res) => {
      const ip = getClientIp(req);
      const user = req.user;
      setLoginCookie(res, user);
      await safeLog({ userId: user.id, provider: 'twitter-oauth', ip, success: 1 });
      res.redirect('/dashboard');
    }
  );
} else {
  console.log('[OAuth] Twitter not configured (missing env vars).');
}

// ---- Role-aware dashboard redirect ----
app.get('/dashboard', (req, res) => {
  try {
    const token = req.cookies?.token;
    if (!token) return res.redirect('/');
    const u = jwt.verify(token, JWT_SECRET);
    switch (u.role) {
      case 'host':
        return res.redirect('/dashboard-host.html');
      case 'partner':
        return res.redirect('/dashboard-partner.html');
      case 'visitor':
      default:
        return res.redirect('/dashboard.html');
    }
  } catch {
    return res.redirect('/');
  }
});

app.get('/api/me', authRequired, async (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: !!process.env.COOKIE_SECURE });
  res.json({ ok: true });
});

app.get('/api/host/me', async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ error: 'Not logged in' });

    const u = jwt.verify(token, JWT_SECRET);
    if (u.role !== 'host') return res.status(403).json({ error: 'Not a host token' });

    const row = await db.get(
      'SELECT id, company_name, email, host_type, selected_services, website, vat_id, suspended, created_at FROM hosts WHERE id = ?',
      [u.id]
    );
    if (!row) return res.status(404).json({ error: 'Host not found' });

    res.json({ host: row });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/api/partner/me', (req, res) => {
  try {
    console.log('[PARTNER /me] cookies:', req.cookies);
    const raw = req.cookies?.token;

    if (!raw || typeof raw !== 'string') {
      console.log('[PARTNER /me] no valid token cookie (type:', typeof raw, ')');
      return res.status(401).json({ error: 'Not logged in' });
    }

    const u = jwt.verify(raw, JWT_SECRET);
    console.log('[PARTNER /me] decoded token:', u);

    if (u.role !== 'partner') {
      console.log('[PARTNER /me] wrong role:', u.role);
      return res.status(403).json({ error: 'Not a partner token' });
    }

    res.json({ email: u.email, company_name: u.name });
  } catch (e) {
    console.error('[PARTNER /me] verify error:', e);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// -----------------------------------------------------------------------------
// Role-aware "what to render" endpoint
// -----------------------------------------------------------------------------
app.get('/api/services', authRequired, async (req, res) => {
  try {
    const { role, id } = req.user;

    let userName = '';
    let createdAt = null;
    let suspended = 0;

    const allModules = await scanModulesFromFS();
    const moduleMap = new Map(
      allModules.map(m => [String(m.service_key || '').toLowerCase(), m])
    );

    const getModuleByKey = (key) => {
      const k = String(key || '').toLowerCase();
      return moduleMap.get(k) || null;
    };

    function buildModulesPayload(allowedKeys, statusResolver) {
      const uniq = [];
      const seen = new Set();
      for (const raw of allowedKeys || []) {
        const k = String(raw || '').toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        uniq.push(k);
      }

      const out = [];
      for (const k of uniq) {
        const mod = moduleMap.get(k);
        if (!mod) continue;
        out.push({
          service_key: mod.service_key,
          display_name: mod.display_name,
          icon_base: mod.icon_base,
          position: mod.position ?? 0,
          managePages: mod.managePages || [],
          usePages: mod.usePages || [],
          status: typeof statusResolver === 'function'
            ? statusResolver(mod)
            : 'active'
        });
      }

      out.sort((a, b) => {
        const pa = Number(a.position || 0);
        const pb = Number(b.position || 0);
        if (pa !== pb) return pa - pb;
        return String(a.service_key || '').localeCompare(String(b.service_key || ''));
      });

      return out;
    }

    const computeStatus = () =>
      suspended
        ? 'suspended'
        : (daysSince(createdAt) <= 14 ? 'trial' : 'active');

    // ---------- HOST ----------
    if (role === 'host') {
      const host = await db.get(
        `SELECT company_name, selected_services, created_at, suspended
         FROM hosts WHERE id = ?`,
        [id]
      );
      if (!host) return res.status(404).json({ error: 'Host not found' });

      userName = host.company_name || 'Host';
      createdAt = host.created_at;
      suspended = Number(host.suspended || 0);

      if (!Object.keys(SERVICE_CODE_TO_MODULE).length &&
          !Object.keys(SERVICE_LABEL_TO_CODE).length) {
        await loadServiceMapping();
      }

      const allowedKeySet = new Set();

      const svcRows = await db.all(
        `SELECT service_key
           FROM account_services
          WHERE role = 'host'
            AND account_id = ?
            AND status = 'active'`,
        [id]
      );
      for (const r of svcRows) {
        if (!r.service_key) continue;
        allowedKeySet.add(r.service_key);
      }

      const rawList = (() => {
        try {
          const parsed = JSON.parse(host.selected_services || '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();

      for (const entry of rawList) {
        if (!entry) continue;
        const asString = String(entry);

        const codeCfg = SERVICE_CODE_TO_MODULE[asString];
        if (codeCfg && codeCfg.module_key) {
          allowedKeySet.add(codeCfg.module_key);
          continue;
        }

        const labelCfg = SERVICE_LABEL_TO_CODE[canon(asString)];
        if (labelCfg && labelCfg.module_key) {
          allowedKeySet.add(labelCfg.module_key);
        }
      }

      let allowedKeys = Array.from(allowedKeySet);
      if (!allowedKeys.length) {
        allowedKeys = allModules.map(m => m.service_key);
      }

      const statusResolver = () => computeStatus();
      const modules = buildModulesPayload(allowedKeys, statusResolver);

      const header = {
        displayName: userName,
        role,
        avatar: null
      };

      return res.json({ user: header, modules });
    }

    // ---------- PARTNER ----------
    if (role === 'partner') {
      const partner = await db.get(
        `SELECT company_name, created_at, suspended
           FROM partners WHERE id = ?`,
        [id]
      );
      if (!partner) return res.status(404).json({ error: 'Partner not found' });

      userName = partner.company_name || 'Partner';
      createdAt = partner.created_at;
      suspended = Number(partner.suspended || 0);

      const svcRows = await db.all(
        `SELECT service_key
           FROM account_services
          WHERE role = 'partner'
            AND account_id = ?
            AND status = 'active'`,
        [id]
      );

      let allowedKeys = svcRows.map(r => r.service_key).filter(Boolean);
      if (!allowedKeys.length) {
        allowedKeys = allModules.map(m => m.service_key);
      }

      const statusResolver = (mod) => {
        const keyLower = String(mod.service_key || '').toLowerCase();
        const nameLower = String(mod.display_name || '').toLowerCase();
        if (keyLower.includes('ads') || nameLower.includes('advert')) {
          return 'upcoming';
        }
        return computeStatus();
      };

      const modules = buildModulesPayload(allowedKeys, statusResolver);

      const header = {
        displayName: userName,
        role,
        avatar: null
      };

      return res.json({ user: header, modules });
    }

    // ---------- VISITOR / GUIDE ----------
    const visitor = await db.get(
      `SELECT name, created_at, suspended
         FROM users WHERE id = ?`,
      [id]
    );
    if (!visitor) return res.status(404).json({ error: 'Visitor not found' });

    userName = visitor.name || 'Visitor';
    createdAt = visitor.created_at;
    suspended = Number(visitor.suspended || 0);

    const svcRows = await db.all(
      `SELECT service_key
         FROM account_services
        WHERE (role = 'visitor' OR role = 'guide')
          AND account_id = ?
          AND status = 'active'`,
      [id]
    );

    let allowedKeys = svcRows.map(r => r.service_key).filter(Boolean);
    if (!allowedKeys.length) {
      allowedKeys = allModules.map(m => m.service_key);
    }

    const statusResolver = () => computeStatus();
    const modules = buildModulesPayload(allowedKeys, statusResolver);

    const header = {
      displayName: userName,
      role,
      avatar: null
    };

    return res.json({ user: header, modules });

  } catch (e) {
    console.error('services error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// In-Time (Queues & Bookings) API — from script 1, integrated with JWT hosts
// -----------------------------------------------------------------------------

// ---- Create a new queue (host) ----
app.post('/api/intime/queues', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);

    const {
      name,
      location,
      gps_lat,
      gps_lng,

      queue_mode, // 'live' | 'advance' | 'mixed'

      anon_booking_allowed,
      requires_login,
      requires_whitelist,

      wave_capacity,
      time_per_slot_minutes,
      show_estimate,

      mixed_patterns,
      operating_days,
      off_duty_periods,

      calendar_sync_google,
      calendar_sync_ms,
      calendar_sync_other,

      valid_from,
      valid_to,
      status = 'active'
    } = req.body;

    if (!name) {
      return res.status(400).json({ ok: false, error: 'MISSING_NAME' });
    }

    if (!queue_mode || !['live', 'advance', 'mixed'].includes(queue_mode)) {
      return res.status(400).json({ ok: false, error: 'Invalid queue_mode' });
    }

    const slug = randomSlug('q');

    const mixedPatternsJson =
      mixed_patterns && mixed_patterns.length
        ? JSON.stringify(mixed_patterns)
        : null;
    const operatingDaysJson =
      operating_days && operating_days.length
        ? JSON.stringify(operating_days)
        : null;
    const offDutyJson =
      off_duty_periods && off_duty_periods.length
        ? JSON.stringify(off_duty_periods)
        : null;

    const result = await db.run(
      `
      INSERT INTO intime_queues (
        host_id,
        name,
        location,
        gps_lat,
        gps_lng,
        queue_mode,
        anon_booking_allowed,
        requires_login,
        requires_whitelist,
        wave_capacity,
        time_per_slot_minutes,
        show_estimate,
        mixed_patterns,
        operating_days,
        off_duty_periods,
        calendar_sync_google,
        calendar_sync_ms,
        calendar_sync_other,
        slug,
        qr_payload,
        status,
        valid_from,
        valid_to
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `,
      [
        hostId,
        name || null,
        location || null,
        gps_lat != null ? Number(gps_lat) : null,
        gps_lng != null ? Number(gps_lng) : null,
        queue_mode,
        toBoolInt(anon_booking_allowed),
        toBoolInt(requires_login),
        toBoolInt(requires_whitelist),
        wave_capacity != null ? Number(wave_capacity) : null,
        time_per_slot_minutes != null ? Number(time_per_slot_minutes) : null,
        toBoolInt(show_estimate),
        mixedPatternsJson,
        operatingDaysJson,
        offDutyJson,
        toBoolInt(calendar_sync_google),
        toBoolInt(calendar_sync_ms),
        toBoolInt(calendar_sync_other),
        slug,
        null,
        status || 'active',
        valid_from || null,
        valid_to || null
      ]
    );

    const queueId = result.lastID;
    const queue = await db.get(
      'SELECT * FROM intime_queues WHERE id = ?',
      queueId
    );

    const qrPayload = buildQueueQrPayload(queue);
    await db.run(
      'UPDATE intime_queues SET qr_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      qrPayload,
      queueId
    );

    return res.json({
      ok: true,
      queueId,
      slug,
      qrPayload
    });
  } catch (err) {
    console.error('Error creating queue:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---- List queues for current host ----
app.get('/api/intime/queues', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const rows = await db.all(
      'SELECT * FROM intime_queues WHERE host_id = ? ORDER BY created_at DESC',
      hostId
    );
    return res.json({ ok: true, queues: rows });
  } catch (err) {
    console.error('Error listing queues:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---- Get queue details by id or slug (public) ----
app.get('/api/intime/queues/:idOrSlug', async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isNumeric = /^\d+$/.test(idOrSlug);
    const row = isNumeric
      ? await db.get(
          'SELECT * FROM intime_queues WHERE id = ?',
          Number(idOrSlug)
        )
      : await db.get('SELECT * FROM intime_queues WHERE slug = ?', idOrSlug);

    if (!row) {
      return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    }

    return res.json({ ok: true, queue: row });
  } catch (err) {
    console.error('Error loading queue:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---- QR image for a queue (PNG) ----
app.get('/api/intime/queues/:id/qr', async (req, res) => {
  try {
    const { id } = req.params;
    const queue = await db.get(
      'SELECT * FROM intime_queues WHERE id = ?',
      Number(id)
    );
    if (!queue) {
      return res.status(404).send('Queue not found');
    }
    const payload = queue.qr_payload || buildQueueQrPayload(queue);
    const pngBuffer = await QRCode.toBuffer(payload, {
      errorCorrectionLevel: 'M',
      type: 'png',
      margin: 2,
      width: 512
    });
    res.setHeader('Content-Type', 'image/png');
    return res.send(pngBuffer);
  } catch (err) {
    console.error('Error generating QR:', err);
    return res.status(500).send('Error generating QR');
  }
});

// ---- Create booking (visitor "use" side) ----
app.post('/api/intime/bookings', async (req, res) => {
  try {
    const {
      queue_id,
      slot_date,
      slot_start,
      slot_end,
      party_size,
      source,
      visitor_email = null,
      visitor_name = null
    } = req.body;

    if (!queue_id) {
      return res.status(400).json({ ok: false, error: 'MISSING_QUEUE_ID' });
    }
    const queue = await db.get(
      'SELECT * FROM intime_queues WHERE id = ?',
      Number(queue_id)
    );
    if (!queue) {
      return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    }

    const code9 = await generateUniqueCode9();
    const size = party_size ? Number(party_size) : 1;

    const result = await db.run(
      `
      INSERT INTO intime_bookings (
        queue_id,
        visitor_id,
        visitor_email,
        visitor_name,
        code9,
        status,
        slot_date,
        slot_start,
        slot_end,
        party_size,
        source
      ) VALUES (?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?)
    `,
      [
        queue.id,
        null,
        visitor_email,
        visitor_name,
        code9,
        slot_date || null,
        slot_start || null,
        slot_end || null,
        size,
        source || null
      ]
    );

    const bookingId = result.lastID;

    const bookingPayload = `booking:${bookingId}`;

    const pngBuffer = await QRCode.toBuffer(bookingPayload, {
      errorCorrectionLevel: 'M',
      type: 'png',
      margin: 2,
      width: 512
    });
    const base64Png = pngBuffer.toString('base64');

    return res.json({
      ok: true,
      booking: {
        id: bookingId,
        queue_id: queue.id,
        code9,
        slot_date,
        slot_start,
        slot_end,
        party_size: size,
        source: source || null
      },
      qr: {
        payload: bookingPayload,
        image_base64: `data:image/png;base64,${base64Png}`
      }
    });
  } catch (err) {
    console.error('Error creating booking:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---- Redeem booking (host “manage” side, Scan & Redeem page) ----
app.post('/api/intime/bookings/:id/redeem', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const hostId = getHostId(req);
    const { redeem_location } = req.body || {};

    const booking = await db.get(
      'SELECT b.*, q.host_id FROM intime_bookings b JOIN intime_queues q ON b.queue_id = q.id WHERE b.id = ?',
      Number(id)
    );
    if (!booking) {
      return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });
    }

    if (hostId && booking.host_id && booking.host_id !== hostId) {
      return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
    }

    if (booking.status === 'redeemed') {
      return res.json({ ok: true, alreadyRedeemed: true });
    }

    await db.run(
      `
      UPDATE intime_bookings
         SET status = 'redeemed',
             redeemed_at = CURRENT_TIMESTAMP,
             redeem_host_id = ?,
             redeem_location = ?
       WHERE id = ?
    `,
      [hostId, redeem_location || null, booking.id]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error redeeming booking:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---- Cancel booking (visitor “use” side) ----
app.post('/api/intime/bookings/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await db.get(
      'SELECT * FROM intime_bookings WHERE id = ?',
      Number(id)
    );
    if (!booking) {
      return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });
    }
    if (booking.status !== 'booked') {
      return res
        .status(400)
        .json({ ok: false, error: 'BOOKING_NOT_ACTIVE' });
    }

    await db.run(
      `
      UPDATE intime_bookings
         SET status = 'cancelled'
       WHERE id = ?
    `,
      booking.id
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error cancelling booking:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// -----------------------------------------------------------------------------
// Fallback (exclude /api routes)
// -----------------------------------------------------------------------------
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Merged server running on http://localhost:${PORT}`));
