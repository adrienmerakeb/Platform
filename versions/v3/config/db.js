// config/db.js
// SQLite initialization + schema + lightweight migrations

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Place DB file at project root: project-root/auth.db
const DB_PATH = path.join(__dirname, '..', 'auth.db');

let dbInstance = null;

/**
 * Internal helper: add column if it does not exist yet.
 */
async function ensureColumn(db, table, column, ddl) {
  const cols = await db.all(`PRAGMA table_info(${table})`);
  const exists = cols.some(
    (c) => String(c.name).toLowerCase() === column.toLowerCase()
  );
  if (!exists) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[MIGRATION] ${table}.${column} added`);
  }
}

/**
 * Initialize DB, create schema if needed, run migrations.
 * Call this once at startup from server.js.
 */
export async function initDB() {
  if (dbInstance) return dbInstance;

  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  // Always enable foreign keys
  await db.exec('PRAGMA foreign_keys = ON;');

  const schemaSQL = `
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

  slug TEXT UNIQUE,
  qr_payload TEXT,

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

  code9 TEXT UNIQUE,
  short_code TEXT UNIQUE,
  booking_token TEXT UNIQUE,

  status TEXT NOT NULL DEFAULT 'booked',

  slot_date TEXT,
  slot_start TEXT,
  slot_end TEXT,
  slot_time DATETIME,
  party_size INTEGER DEFAULT 1,
  source TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  redeemed_at DATETIME,
  redeem_host_id INTEGER,
  redeem_location TEXT,

  FOREIGN KEY(queue_id) REFERENCES intime_queues(id) ON DELETE CASCADE
);

-- Calendar connections (per host)
CREATE TABLE IF NOT EXISTS calendar_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER NOT NULL,
  provider TEXT NOT NULL,          -- 'google', 'ms', etc.
  external_id TEXT,
  email TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_type TEXT,
  scope TEXT,
  expiry_date INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(host_id) REFERENCES hosts(id) ON DELETE CASCADE
);
`;

  await db.exec(schemaSQL);

  // Migrations for older DBs (no-op if columns already exist)
  await ensureColumn(
    db,
    'users',
    'suspended',
    'suspended INTEGER NOT NULL DEFAULT 0'
  );
  await ensureColumn(
    db,
    'users',
    'status',
    "status TEXT DEFAULT 'V'"
  );
  await ensureColumn(
    db,
    'hosts',
    'suspended',
    'suspended INTEGER NOT NULL DEFAULT 0'
  );
  await ensureColumn(
    db,
    'partners',
    'suspended',
    'suspended INTEGER NOT NULL DEFAULT 0'
  );
  await ensureColumn(
    db,
    'intime_queues',
    'calendar_connection_id',
    'calendar_connection_id INTEGER'
  );

  dbInstance = db;
  console.log('[DB] SQLite initialised at', DB_PATH);
  return dbInstance;
}

/**
 * Get the already-initialized DB instance.
 * Throws if initDB() has not been called yet.
 */
export function getDB() {
  if (!dbInstance) {
    throw new Error(
      'DB not initialized. Call initDB() from server startup before using getDB().'
    );
  }
  return dbInstance;
}
