-- Additive, release-gated migration. Do not run against production without approval.
ALTER TABLE public.activity_logs
  ADD COLUMN IF NOT EXISTS activity_event_id TEXT,
  ADD COLUMN IF NOT EXISTS canonical_activity_id TEXT,
  ADD COLUMN IF NOT EXISTS map_id TEXT,
  ADD COLUMN IF NOT EXISTS session_id TEXT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS activity_logs_student_activity_event_id_unique
  ON public.activity_logs (student_id, activity_event_id)
  WHERE activity_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.student_quest_milestones (
  id BIGSERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL,
  map_id TEXT,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
  learning_cycle_version INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, milestone_id, learning_cycle_version)
);

CREATE INDEX IF NOT EXISTS student_quest_milestones_student_cycle_idx
  ON public.student_quest_milestones (student_id, learning_cycle_version);
