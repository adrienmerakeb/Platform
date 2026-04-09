-- migration: visitor allowlist + access requests
-- Safe to run multiple times (idempotent).

-- ── Allowlist ──────────────────────────────────────────────────────────────
-- One row per (queue, email). The host explicitly adds visitors here.
CREATE TABLE IF NOT EXISTS public.queue_visitors (
  id         SERIAL       PRIMARY KEY,
  queue_id   INTEGER      NOT NULL REFERENCES public.queues(queue_id) ON DELETE CASCADE,
  email      TEXT         NOT NULL,
  added_by   INTEGER      NULL,      -- host user id
  note       TEXT         NULL,      -- optional host note
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (queue_id, email)
);
CREATE INDEX IF NOT EXISTS idx_queue_visitors_queue ON public.queue_visitors(queue_id);
CREATE INDEX IF NOT EXISTS idx_queue_visitors_email ON public.queue_visitors(email);

-- ── Access requests ────────────────────────────────────────────────────────
-- Visitors submit a request to be added to the allowlist.
-- status: 'pending' | 'approved' | 'denied'
CREATE TABLE IF NOT EXISTS public.queue_access_requests (
  id           SERIAL       PRIMARY KEY,
  queue_id     INTEGER      NOT NULL REFERENCES public.queues(queue_id) ON DELETE CASCADE,
  email        TEXT         NOT NULL,
  display_name TEXT         NULL,
  message      TEXT         NULL,    -- visitor's optional message
  status       TEXT         NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','denied')),
  decided_at   TIMESTAMPTZ  NULL,
  decided_by   INTEGER      NULL,    -- host user id
  host_note    TEXT         NULL,    -- message sent back to visitor
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (queue_id, email)           -- one open request per email per queue
);
CREATE INDEX IF NOT EXISTS idx_access_requests_queue  ON public.queue_access_requests(queue_id);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON public.queue_access_requests(queue_id, status);
