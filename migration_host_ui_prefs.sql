-- migration: host_ui_prefs
-- Stores per-host UI preferences (page styling, etc.)
-- Safe to run multiple times (idempotent).

CREATE TABLE IF NOT EXISTS public.host_ui_prefs (
  host_id    INTEGER      PRIMARY KEY,   -- matches req.user.id
  prefs      JSONB        NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Index for fast single-host lookup (the only query pattern used)
CREATE INDEX IF NOT EXISTS idx_host_ui_prefs_host_id
  ON public.host_ui_prefs (host_id);

-- Comment
COMMENT ON TABLE  public.host_ui_prefs IS 'Per-host UI/styling preferences, keyed by host user id.';
COMMENT ON COLUMN public.host_ui_prefs.prefs IS 'JSON bag of namespaced prefs, e.g. { "scan_page": { "accent": "#7c3aed", ... } }';
