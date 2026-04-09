// config/db.js — PostgreSQL (drop-in replacement for SQLite version)

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') || process.env.DATABASE_URL?.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('[PG] idle client error:', err.message));

// -----------------------------------------------------------------------------
// Compatibility wrappers — same API as the sqlite package used in all routes:
//   db.get(sql, params)  → first row or undefined
//   db.all(sql, params)  → array of rows
//   db.run(sql, params)  → { lastID, changes }
//   db.exec(sql)         → void
// -----------------------------------------------------------------------------

function toPositional(sql) {
  // Convert SQLite ? placeholders → PostgreSQL $1 $2 $3 ...
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const db = {
  async get(sql, params = []) {
    const { rows } = await pool.query(toPositional(sql), params);
    return rows[0];
  },

  async all(sql, params = []) {
    const { rows } = await pool.query(toPositional(sql), params);
    return rows;
  },

  async run(sql, params = []) {
    const pgSql = toPositional(sql);
    const result = await pool.query(pgSql, params);
    return {
      lastID: result.rows[0]?.id ?? undefined,
      changes: result.rowCount
    };
  },

  async exec(sql) {
    // exec() is used for multi-statement DDL and transactions in routes.
    // Split on ; and run each statement individually.
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
  },


  // Transaction helper — db.tx(async (t) => { ... })
  // t exposes the same get/all/run/exec surface bound to a single client
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = {
        async get(sql, params = []) {
          const { rows } = await client.query(toPositional(sql), params);
          return rows[0];
        },
        async all(sql, params = []) {
          const { rows } = await client.query(toPositional(sql), params);
          return rows;
        },
        async run(sql, params = []) {
          const pgSql = toPositional(sql);
          const result = await client.query(pgSql, params);
          return { lastID: result.rows[0]?.id ?? undefined, changes: result.rowCount };
        },
        async exec(sql) {
          const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
          for (const stmt of statements) await client.query(stmt);
        },
      };
      const result = await fn(t);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // Raw pool client — used by routes that need manual BEGIN/COMMIT/ROLLBACK
  async getClient() {
    return pool.connect();
  },

  // Direct pool query access if ever needed
  query: (...args) => pool.query(...args)
};

// -----------------------------------------------------------------------------
// Schema — mirrors the SQLite schema exactly, translated to PostgreSQL DDL
// -----------------------------------------------------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id               SERIAL PRIMARY KEY,
      name             TEXT,
      email            TEXT NOT NULL UNIQUE,
      password_hash    TEXT NOT NULL DEFAULT '',
      role             TEXT DEFAULT 'visitor',
      status           TEXT DEFAULT 'V',
      has_guide_profile INTEGER DEFAULT 0,
      provider         TEXT,
      provider_id      TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      suspended        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reset_tokens (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      token      TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hosts (
      id                SERIAL PRIMARY KEY,
      company_name      TEXT NOT NULL,
      email             TEXT NOT NULL UNIQUE,
      password_hash     TEXT NOT NULL,
      host_type         TEXT,
      selected_services TEXT,
      website           TEXT,
      vat_id            TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      suspended         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reset_tokens_host (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      token      TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS partners (
      id            SERIAL PRIMARY KEY,
      company_name  TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      website       TEXT,
      vat_id        TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      suspended     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reset_tokens_partner (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      token      TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connection_logs (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER,
      provider   TEXT,
      ip         TEXT,
      success    INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS services (
      service_key  TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status       TEXT DEFAULT 'active',
      position     INTEGER DEFAULT 100,
      icon_base    TEXT
    );

    CREATE TABLE IF NOT EXISTS account_services (
      id          SERIAL PRIMARY KEY,
      role        TEXT NOT NULL,
      account_id  INTEGER NOT NULL,
      service_key TEXT NOT NULL,
      status      TEXT DEFAULT 'active',
      UNIQUE(role, account_id, service_key)
    );

    CREATE TABLE IF NOT EXISTS intime_queues (
      id                      SERIAL PRIMARY KEY,
      host_id                 INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
      name                    TEXT,
      location                TEXT,
      gps_lat                 REAL,
      gps_lng                 REAL,
      queue_mode              TEXT NOT NULL DEFAULT 'live',
      anon_booking_allowed    INTEGER DEFAULT 0,
      requires_login          INTEGER DEFAULT 0,
      requires_whitelist      INTEGER DEFAULT 0,
      wave_capacity           INTEGER,
      time_per_slot_minutes   INTEGER,
      show_estimate           INTEGER DEFAULT 0,
      mixed_patterns          TEXT,
      operating_days          TEXT,
      off_duty_periods        TEXT,
      calendar_sync_google    INTEGER DEFAULT 0,
      calendar_sync_ms        INTEGER DEFAULT 0,
      calendar_sync_other     INTEGER DEFAULT 0,
      internal_calendar_id    INTEGER,
      slug                    TEXT UNIQUE,
      qr_payload              TEXT,
      status                  TEXT DEFAULT 'active',
      valid_from              TIMESTAMPTZ,
      valid_to                TIMESTAMPTZ,
      allowed_visitors_emails TEXT,
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      updated_at              TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS intime_queue_allowed_visitors (
      id       SERIAL PRIMARY KEY,
      queue_id INTEGER NOT NULL REFERENCES intime_queues(id) ON DELETE CASCADE,
      email    TEXT NOT NULL,
      UNIQUE(queue_id, email)
    );

    CREATE TABLE IF NOT EXISTS intime_bookings (
      id              SERIAL PRIMARY KEY,
      queue_id        INTEGER NOT NULL REFERENCES intime_queues(id) ON DELETE CASCADE,
      visitor_id      INTEGER,
      visitor_email   TEXT,
      visitor_name    TEXT,
      code9           TEXT,
      short_code      TEXT UNIQUE,
      booking_token   TEXT UNIQUE,
      status          TEXT NOT NULL DEFAULT 'booked',
      slot_date       TEXT,
      slot_start      TEXT,
      slot_end        TEXT,
      slot_time       TIMESTAMPTZ,
      party_size      INTEGER DEFAULT 1,
      source          TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      redeemed_at     TIMESTAMPTZ,
      redeem_host_id  INTEGER,
      redeem_location TEXT
    );

    CREATE TABLE IF NOT EXISTS queue_calendars (
      id         SERIAL PRIMARY KEY,
      queue_id   INTEGER NOT NULL UNIQUE REFERENCES intime_queues(id) ON DELETE CASCADE,
      host_id    INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      timezone   TEXT DEFAULT 'UTC',
      status     TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS queue_calendar_blocks (
      id              SERIAL PRIMARY KEY,
      calendar_id     INTEGER NOT NULL REFERENCES queue_calendars(id) ON DELETE CASCADE,
      start_utc       TEXT NOT NULL,
      end_utc         TEXT NOT NULL,
      source_provider TEXT,
      source_ref      TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS host_calendar_connections (
      id               SERIAL PRIMARY KEY,
      host_id          INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      provider         TEXT NOT NULL,
      external_account TEXT,
      access_token     TEXT,
      refresh_token    TEXT,
      token_expires_at TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(host_id, provider)
    );

    CREATE TABLE IF NOT EXISTS calendar_connections (
      id            SERIAL PRIMARY KEY,
      host_id       INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      provider      TEXT NOT NULL,
      external_id   TEXT,
      email         TEXT,
      access_token  TEXT,
      refresh_token TEXT,
      token_type    TEXT,
      scope         TEXT,
      expiry_date   BIGINT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(host_id, provider)
    );

    CREATE TABLE IF NOT EXISTS lgo_guides (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      owner_role       TEXT DEFAULT 'visitor',
      owner_account_id INTEGER,
      display_name     TEXT,
      bio              TEXT,
      credentials      TEXT,
      avatar_url       TEXT,
      wallpaper_url    TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lgo_guidings (
      id                     SERIAL PRIMARY KEY,
      guide_id               INTEGER NOT NULL REFERENCES lgo_guides(id) ON DELETE CASCADE,
      title                  TEXT NOT NULL,
      type                   TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'draft',
      is_active              INTEGER NOT NULL DEFAULT 1,
      free_use               INTEGER NOT NULL DEFAULT 1,
      monetization_model     TEXT DEFAULT 'ads',
      price_cents            INTEGER DEFAULT 0,
      allow_teasers          INTEGER NOT NULL DEFAULT 0,
      tipping_enabled        INTEGER NOT NULL DEFAULT 0,
      offline_allowed        INTEGER NOT NULL DEFAULT 0,
      languages_json         TEXT,
      start_lat              REAL,
      start_lng              REAL,
      end_lat                REAL,
      end_lng                REAL,
      start_label            TEXT,
      end_label              TEXT,
      length_km              REAL,
      duration_min           INTEGER,
      transport_modes_json   TEXT,
      description            TEXT,
      tags                   TEXT,
      recommendations        TEXT,
      standard_radius_m      INTEGER DEFAULT 50,
      primary_country        TEXT,
      primary_city           TEXT,
      countries_cities_json  TEXT,
      transport_summary_json TEXT,
      has_fees               INTEGER NOT NULL DEFAULT 0,
      has_accessibility      INTEGER NOT NULL DEFAULT 0,
      has_emergency_services INTEGER NOT NULL DEFAULT 0,
      rating_avg             REAL DEFAULT 0,
      rating_count           INTEGER DEFAULT 0,
      total_earned_cents     INTEGER DEFAULT 0,
      total_tips_cents       INTEGER DEFAULT 0,
      published_at           TIMESTAMPTZ,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lgo_guiding_steps (
      id                  SERIAL PRIMARY KEY,
      guiding_id          INTEGER NOT NULL REFERENCES lgo_guidings(id) ON DELETE CASCADE,
      order_index         INTEGER NOT NULL,
      title               TEXT,
      lat                 REAL NOT NULL,
      lng                 REAL NOT NULL,
      description         TEXT,
      recommendations     TEXT,
      audio_url           TEXT NOT NULL DEFAULT '',
      image_urls_json     TEXT,
      video_urls_json     TEXT,
      transport_mode      TEXT,
      radius_override_m   INTEGER,
      country             TEXT,
      city                TEXT,
      transport_modes_json TEXT,
      has_fee             INTEGER NOT NULL DEFAULT 0,
      has_accessibility   INTEGER NOT NULL DEFAULT 0,
      emergency_tags_json TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_queue_calendar_blocks_calendar
      ON queue_calendar_blocks(calendar_id, start_utc);
    CREATE INDEX IF NOT EXISTS idx_queue_calendar_blocks_range
      ON queue_calendar_blocks(start_utc, end_utc);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_calendar_blocks_dedupe
      ON queue_calendar_blocks(calendar_id, source_provider, source_ref);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_connections_host_provider
      ON calendar_connections(host_id, provider);
    CREATE INDEX IF NOT EXISTS idx_lgo_guidings_guide
      ON lgo_guidings(guide_id);
    CREATE INDEX IF NOT EXISTS idx_lgo_guidings_status
      ON lgo_guidings(status, is_active);
    CREATE INDEX IF NOT EXISTS idx_lgo_steps_guiding
      ON lgo_guiding_steps(guiding_id, order_index);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lgo_guides_owner
      ON lgo_guides(owner_role, owner_account_id);
  `);

  console.log('[DB] PostgreSQL schema ready');
}

// -----------------------------------------------------------------------------
// Exports — identical surface to the SQLite version
// -----------------------------------------------------------------------------
export function getDb() { return db; }
export const getDB = getDb;
export { initDb };

await initDb();
