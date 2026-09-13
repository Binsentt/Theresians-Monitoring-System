BEGIN;

ALTER TABLE public.activity_logs
  ADD COLUMN IF NOT EXISTS telemetry_contract_version VARCHAR(32),
  ADD COLUMN IF NOT EXISTS quest_graph_version VARCHAR(64),
  ADD COLUMN IF NOT EXISTS map_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS canonical_activity_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS canonical_quest_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS canonical_task_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS canonical_milestone_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS activity_event_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS session_id BIGINT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS is_player_facing BOOLEAN;

CREATE UNIQUE INDEX IF NOT EXISTS activity_logs_student_activity_event_unique
  ON public.activity_logs (student_id, activity_event_id)
  WHERE activity_event_id IS NOT NULL;

ALTER TABLE public.game_results
  ADD COLUMN IF NOT EXISTS result_event_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS telemetry_contract_version VARCHAR(32),
  ADD COLUMN IF NOT EXISTS quest_graph_version VARCHAR(64),
  ADD COLUMN IF NOT EXISTS session_id BIGINT,
  ADD COLUMN IF NOT EXISTS map_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS canonical_quest_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS canonical_task_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS canonical_battle_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS canonical_milestone_id VARCHAR(200);

CREATE UNIQUE INDEX IF NOT EXISTS game_results_student_result_event_unique
  ON public.game_results (resolved_student_id, result_event_id)
  WHERE resolved_student_id IS NOT NULL AND result_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.student_quest_milestones (
  id BIGSERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  learning_cycle_version INTEGER NOT NULL DEFAULT 0,
  telemetry_contract_version VARCHAR(32) NOT NULL,
  quest_graph_version VARCHAR(64) NOT NULL,
  map_id VARCHAR(100) NOT NULL,
  canonical_quest_id VARCHAR(160) NOT NULL,
  canonical_task_id VARCHAR(160) NOT NULL,
  canonical_milestone_id VARCHAR(200) NOT NULL,
  player_facing BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_activity_event_id VARCHAR(200),
  UNIQUE (student_id, learning_cycle_version, canonical_milestone_id)
);

CREATE INDEX IF NOT EXISTS student_quest_milestones_student_cycle_index
  ON public.student_quest_milestones (student_id, learning_cycle_version, completed_at);

COMMIT;
