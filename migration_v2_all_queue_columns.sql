-- Migration: Add ALL missing columns to public.queues
-- Safe to run multiple times (IF NOT EXISTS).
-- Uses TEXT for JSON columns (consistent with existing channels_json, publics_json, etc.)
-- Run with: psql "postgresql://postgres:Hubble1956@localhost:5432/intime"
-- Then paste this entire block.

-- From previous migration (may already exist):
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS schedule_json       TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS slots_json          TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS wave_duration       INTEGER;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS wave_capacity       INTEGER;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS flow_capacity       INTEGER;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS release_mode        TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS release_count       INTEGER;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS release_interval    INTEGER;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS calling_json        TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS early_json          TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS use_host_wall       BOOLEAN DEFAULT TRUE;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS noscan_win          INTEGER DEFAULT 10;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS scan_fallback       BOOLEAN DEFAULT FALSE;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS payment_mode        TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS operators_json      TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS resellers_json      TEXT;

-- NEW columns for wave/flow advanced config:
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS wave_cap_mode       TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS wave_var_scope      TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS wave_schedule_json  TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS flow_cap_mode       TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS flow_schedule_json  TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS fixed_release_scope TEXT;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS release_schedule_json TEXT;

-- NEW columns for access extras:
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS access_req          BOOLEAN DEFAULT FALSE;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS bulk_invite         BOOLEAN DEFAULT TRUE;

-- NEW columns for display/calendar extras:
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS show_operator_name  BOOLEAN DEFAULT TRUE;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS manual_refresh      BOOLEAN DEFAULT TRUE;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS conf_review         BOOLEAN DEFAULT TRUE;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS bulk_res            BOOLEAN DEFAULT TRUE;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS notify_imp          BOOLEAN DEFAULT TRUE;

-- NEW column for wallpaper (base64 data URL):
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS wallpaper_data      TEXT;
