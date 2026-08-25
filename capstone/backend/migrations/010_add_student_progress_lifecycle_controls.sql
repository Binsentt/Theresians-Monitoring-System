-- Extends migration 009's timestamp boundary with one canonical, monotonic
-- cycle version and progress-archive metadata per Student. This migration is
-- additive: existing Students and historic playtime sessions start at version 0.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS current_learning_cycle_version INTEGER NOT NULL DEFAULT 0
    CHECK (current_learning_cycle_version >= 0),
  ADD COLUMN IF NOT EXISTS progress_archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS progress_archived_by INTEGER
    REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS progress_archive_reason VARCHAR(1000);

ALTER TABLE public.playtime_sessions
  ADD COLUMN IF NOT EXISTS learning_cycle_version INTEGER NOT NULL DEFAULT 0
    CHECK (learning_cycle_version >= 0);

CREATE INDEX IF NOT EXISTS idx_accounts_student_progress_archive
  ON public.accounts (progress_archived_at, current_learning_cycle_version)
  WHERE LOWER(role) = 'student';

CREATE INDEX IF NOT EXISTS idx_playtime_sessions_student_cycle
  ON public.playtime_sessions (student_id, learning_cycle_version, status);
