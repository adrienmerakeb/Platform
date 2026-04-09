-- Migration: Add missing columns to public.queues
-- These columns are required for the edit page (page_1-2.html) to persist all queue settings.
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS schedule_json     JSONB         DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS slots_json        JSONB         DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS wave_duration     INTEGER       DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS wave_capacity     INTEGER       DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS flow_capacity     INTEGER       DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS release_mode      TEXT          DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS release_count     INTEGER       DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS release_interval  INTEGER       DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS calling_json      JSONB         DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS early_json        JSONB         DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS use_host_wall     BOOLEAN       DEFAULT TRUE;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS noscan_win        INTEGER       DEFAULT 10;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS scan_fallback     BOOLEAN       DEFAULT FALSE;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS payment_mode      TEXT          DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS operators_json    JSONB         DEFAULT NULL;
ALTER TABLE public.queues ADD COLUMN IF NOT EXISTS resellers_json    JSONB         DEFAULT NULL;
