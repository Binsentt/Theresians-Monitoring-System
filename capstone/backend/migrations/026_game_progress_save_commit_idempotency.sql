-- Durable idempotency receipts for retried game progress commits.
-- Existing progress and activity records are left untouched.
CREATE TABLE IF NOT EXISTS public.game_progress_save_commits (
  student_id INTEGER NOT NULL
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  learning_cycle_version INTEGER NOT NULL
    CHECK (learning_cycle_version >= 0),
  save_commit_id_hash TEXT NOT NULL
    CHECK (save_commit_id_hash ~ '^[0-9a-f]{64}$'),
  payload_sha256 TEXT NOT NULL
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  activity_event_key TEXT NOT NULL,
  response_status SMALLINT NOT NULL DEFAULT 201
    CHECK (response_status BETWEEN 200 AND 299),
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  CONSTRAINT game_progress_save_commits_pkey
    PRIMARY KEY (student_id, learning_cycle_version, save_commit_id_hash),
  CONSTRAINT game_progress_save_commits_activity_event_unique
    UNIQUE (student_id, activity_event_key),
  CONSTRAINT game_progress_save_commits_completion_consistency
    CHECK ((response_body IS NULL) = (completed_at IS NULL))
);
