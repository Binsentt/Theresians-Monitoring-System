-- Additive continuation of migration 021. Existing 021 already owns the
-- activity-event columns and the base milestone table.
BEGIN;

ALTER TABLE public.activity_logs
  ADD COLUMN IF NOT EXISTS telemetry_contract_version VARCHAR(32),
  ADD COLUMN IF NOT EXISTS quest_graph_version VARCHAR(64),
  ADD COLUMN IF NOT EXISTS canonical_quest_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS canonical_task_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS canonical_milestone_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS is_player_facing BOOLEAN;

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

ALTER TABLE public.student_quest_milestones
  ADD COLUMN IF NOT EXISTS telemetry_contract_version VARCHAR(32),
  ADD COLUMN IF NOT EXISTS quest_graph_version VARCHAR(64),
  ADD COLUMN IF NOT EXISTS canonical_quest_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS canonical_task_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS canonical_milestone_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS player_facing BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS source_activity_event_id VARCHAR(200);

CREATE INDEX IF NOT EXISTS student_quest_milestones_student_cycle_completed_idx
  ON public.student_quest_milestones (student_id, learning_cycle_version, completed_at);

ALTER TABLE public.learning_files
  ADD COLUMN IF NOT EXISTS generation_remaining_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS generation_failed_batch_index INTEGER,
  ADD COLUMN IF NOT EXISTS generation_retry_count INTEGER NOT NULL DEFAULT 0;

COMMIT;
