-- Canonical curriculum topics are code-owned registry identifiers.
-- Keep these columns nullable so historical display-topic rows remain readable
-- without an automatic rewrite or unsafe inferred backfill.
ALTER TABLE public.learning_files
  ADD COLUMN IF NOT EXISTS topic_id VARCHAR(100) NULL;

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS topic_id VARCHAR(100) NULL;

CREATE INDEX IF NOT EXISTS learning_files_scope_topic_id_index
  ON public.learning_files (grade_level, difficulty, topic_id)
  WHERE topic_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS questions_learning_file_topic_id_index
  ON public.questions (learning_file_id, topic_id)
  WHERE topic_id IS NOT NULL;
