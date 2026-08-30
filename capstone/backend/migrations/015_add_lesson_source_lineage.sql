-- Reusable Lesson PDFs are source material. Generated question sets remain
-- independent learning_files rows and optionally point back to that source.
-- This migration is additive: existing learning_files remain question_set rows.
ALTER TABLE public.learning_files
  ADD COLUMN IF NOT EXISTS content_role VARCHAR(32) NOT NULL DEFAULT 'question_set',
  ADD COLUMN IF NOT EXISTS source_learning_file_id INTEGER
    REFERENCES public.learning_files(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'learning_files_content_role_check'
      AND conrelid = 'public.learning_files'::regclass
  ) THEN
    ALTER TABLE public.learning_files
      ADD CONSTRAINT learning_files_content_role_check
      CHECK (content_role IN ('lesson_source', 'question_set'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS learning_files_source_learning_file_id_index
  ON public.learning_files (source_learning_file_id)
  WHERE source_learning_file_id IS NOT NULL;
