-- Durable, actor-scoped request identity for AI lesson generation.
-- This migration is additive and intentionally preserves existing lesson records.
ALTER TABLE public.learning_files
  ADD COLUMN IF NOT EXISTS generation_idempotency_key VARCHAR(128),
  ADD COLUMN IF NOT EXISTS generation_request_fingerprint VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS learning_files_lesson_generation_idempotency_unique
  ON public.learning_files (uploaded_by, generation_idempotency_key)
  WHERE source = 'lesson'
    AND generation_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS learning_files_lesson_generation_in_progress_fingerprint_unique
  ON public.learning_files (uploaded_by, generation_request_fingerprint)
  WHERE source = 'lesson'
    AND generation_request_fingerprint IS NOT NULL
    AND generation_status = 'generating';
