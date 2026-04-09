-- =============================================================================
-- In-Time: public.* schema migration v1
-- Run once in psql against the "intime" database:
--   psql -U postgres -d intime -f intime_migration_v1.sql
-- Safe to re-run — all statements use CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. public.queues
--    Core queue record. Created by POST /api/intime/queues.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.queues (
  queue_id          BIGSERIAL     PRIMARY KEY,
  host_id           INTEGER       NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,

  -- Identity
  name              TEXT          NOT NULL,
  internal_label    TEXT,
  venue_name        TEXT,

  -- Location
  location_text     TEXT,
  location_geo      JSONB,            -- { text, lat, lng }
  timezone          TEXT          NOT NULL DEFAULT 'UTC',
  home_region       TEXT          NOT NULL DEFAULT 'EU',

  -- Behaviour
  archetype         TEXT          NOT NULL DEFAULT 'C',
    -- 'A' resource-booking | 'B' individual | 'C' wave | 'D' continuous
  booking_formula   TEXT          NOT NULL DEFAULT 'LIVE_ONLY',
    -- 'ADVANCE_ONLY' | 'LIVE_ONLY' | 'MIXED'
  capacity_model    TEXT          NOT NULL DEFAULT 'WAVES',
  identity_policy   TEXT          NOT NULL DEFAULT 'ANON_OK',
    -- 'ANON_OK' | 'LOGIN_REQUIRED' | 'WHITELIST_ONLY'
  admission_mode    TEXT,
    -- 'free' | 'paid' | 'invite'
  no_scan_mode_enabled BOOLEAN    NOT NULL DEFAULT false,

  -- Extended config (stored as JSON blobs for now; can be normalised later)
  schedule_json     JSONB,            -- S.schedule
  slots_json        JSONB,            -- S.slots  (arch A/B)
  wave_config_json  JSONB,            -- wave duration, capacity, schedule (arch C)
  release_config_json JSONB,          -- release method + schedule (arch D)
  calling_json      JSONB,            -- adv_lead, noscan_win, scan_fallback
  early_spot_json   JSONB,            -- early.enabled / interval / max / window
  channels_json     JSONB,            -- ['email','sms',…]
  publics_json      JSONB,            -- access_publics array
  operators_json    JSONB,            -- operators array (provisioned separately too)

  -- Display / UX
  language          TEXT          DEFAULT 'en',
  currency          TEXT          DEFAULT 'USD',
  theme             TEXT,
  use_host_wall     BOOLEAN       NOT NULL DEFAULT true,
  show_eet          BOOLEAN       NOT NULL DEFAULT true,
  show_ete          BOOLEAN       NOT NULL DEFAULT false,
  show_desk_id      BOOLEAN       NOT NULL DEFAULT false,
  sender_email      TEXT,

  -- Calendar
  cal_sync          BOOLEAN       NOT NULL DEFAULT false,
  cal_provider      TEXT,
  sync_horizon      INTEGER       DEFAULT 90,
  manual_refresh    BOOLEAN       NOT NULL DEFAULT true,
  conf_review       BOOLEAN       NOT NULL DEFAULT true,
  bulk_res          BOOLEAN       NOT NULL DEFAULT true,
  notify_imp        BOOLEAN       NOT NULL DEFAULT true,

  -- Lifecycle
  is_active         BOOLEAN       NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. public.device_identities
--    Tracks anonymous visitor devices (needed as FK target for holds/bookings)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.device_identities (
  device_id     TEXT          PRIMARY KEY,   -- client-generated UUID or fingerprint
  first_seen_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. public.holds
--    Short-lived reservation locks (15 min TTL) before a booking is confirmed
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.holds (
  hold_id         BIGSERIAL     PRIMARY KEY,
  queue_id        BIGINT        NOT NULL REFERENCES public.queues(queue_id) ON DELETE CASCADE,
  device_id       TEXT          NOT NULL REFERENCES public.device_identities(device_id),
  status          TEXT          NOT NULL DEFAULT 'HELD',
    -- 'HELD' | 'RELEASED' | 'EXPIRED' | 'CONVERTED'
  valid_use_day   DATE          NOT NULL,
  expires_at      TIMESTAMPTZ   NOT NULL,
  party_size      INTEGER       NOT NULL DEFAULT 1,
  source          TEXT,             -- 'web' | 'app' | 'kiosk' …
  reason          TEXT,
  idempotency_key TEXT          UNIQUE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_holds_queue_day
  ON public.holds (queue_id, valid_use_day, status);

-- ---------------------------------------------------------------------------
-- 4. public.bookings
--    Confirmed bookings. Slots can be for a day (advance) or immediate (live).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bookings (
  booking_id          BIGSERIAL   PRIMARY KEY,
  queue_id            BIGINT      NOT NULL REFERENCES public.queues(queue_id) ON DELETE CASCADE,
  user_id             INTEGER,            -- NULL for anonymous
  device_id           TEXT        REFERENCES public.device_identities(device_id),
  status              TEXT        NOT NULL DEFAULT 'BOOKED',
    -- 'BOOKED' | 'REDEEMED' | 'CANCELLED' | 'EXPIRED' | 'NO_SHOW'
  token_id            UUID        UNIQUE NOT NULL,
  human_ref_alias     CHAR(8),
  human_ref_checksum  CHAR(1),
  valid_use_day       DATE        NOT NULL,
  expires_at          TIMESTAMPTZ,
  party_size          INTEGER     NOT NULL DEFAULT 1,
  source              TEXT,
  idempotency_key     TEXT        UNIQUE,
  redeemed_at         TIMESTAMPTZ,
  redeem_host_id      INTEGER,
  redeem_location     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (human_ref_alias, human_ref_checksum)   -- collision guard
);

CREATE INDEX IF NOT EXISTS idx_bookings_queue_day
  ON public.bookings (queue_id, valid_use_day, status);

-- ---------------------------------------------------------------------------
-- 5. public.queue_day_capacity
--    Per-day capacity ceiling for availability checks.
--    Populated when the host configures capacity for a specific date.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.queue_day_capacity (
  id             BIGSERIAL   PRIMARY KEY,
  queue_id       BIGINT      NOT NULL REFERENCES public.queues(queue_id) ON DELETE CASCADE,
  day            DATE        NOT NULL,
  capacity_total INTEGER     NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (queue_id, day)
);

-- ---------------------------------------------------------------------------
-- 6. Operator tables  (used by POST /api/host/operators  — not yet wired
--    in intimeHost.js but provisioned from page_1.html after queue creation)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.host_operators (
  operator_id   BIGSERIAL   PRIMARY KEY,
  host_id       INTEGER     NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  display_name  TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (host_id, email)
);

CREATE TABLE IF NOT EXISTS public.operator_queue_access (
  id          BIGSERIAL   PRIMARY KEY,
  operator_id BIGINT      NOT NULL REFERENCES public.host_operators(operator_id) ON DELETE CASCADE,
  queue_id    BIGINT      REFERENCES public.queues(queue_id) ON DELETE CASCADE,
    -- NULL means "all queues for the host"
  UNIQUE (operator_id, queue_id)
);

CREATE TABLE IF NOT EXISTS public.operator_permissions (
  id          BIGSERIAL   PRIMARY KEY,
  operator_id BIGINT      NOT NULL REFERENCES public.host_operators(operator_id) ON DELETE CASCADE,
  permission  TEXT        NOT NULL,
    -- e.g. 'scan', 'manage_queue', 'view_reports', 'call_next'
  UNIQUE (operator_id, permission)
);

CREATE TABLE IF NOT EXISTS public.operator_login_tokens (
  token_id    BIGSERIAL   PRIMARY KEY,
  operator_id BIGINT      NOT NULL REFERENCES public.host_operators(operator_id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.operator_audit_log (
  log_id      BIGSERIAL   PRIMARY KEY,
  operator_id BIGINT      NOT NULL REFERENCES public.host_operators(operator_id) ON DELETE CASCADE,
  queue_id    BIGINT      REFERENCES public.queues(queue_id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Done.
-- =============================================================================
