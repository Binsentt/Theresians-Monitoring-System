ALTER TABLE public.playtime_sessions
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS deletion_operation_id UUID;

CREATE INDEX IF NOT EXISTS idx_playtime_sessions_visible_history
  ON public.playtime_sessions(deleted_at, date_played);
