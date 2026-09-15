BEGIN;

ALTER TABLE public.game_results
  ADD COLUMN IF NOT EXISTS question_presented_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS answer_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS response_time_seconds INTEGER;

ALTER TABLE public.game_results
  DROP CONSTRAINT IF EXISTS game_results_response_time_nonnegative;
ALTER TABLE public.game_results
  ADD CONSTRAINT game_results_response_time_nonnegative
  CHECK (response_time_seconds IS NULL OR response_time_seconds >= 0);

CREATE TABLE IF NOT EXISTS public.playtime_deletion_tombstones (
  id BIGSERIAL PRIMARY KEY,
  deleted_record_id INTEGER NOT NULL,
  deleted_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
  deletion_reason VARCHAR(1000) NOT NULL,
  deletion_operation_id UUID NOT NULL,
  target_fingerprint CHAR(64) NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS playtime_deletion_tombstone_record_unique
  ON public.playtime_deletion_tombstones (deleted_record_id);

COMMIT;
