-- Explicit review approval for pending question sets. This migration is additive:
-- it preserves existing question content, publication history, and active game content.
ALTER TABLE public.learning_files
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(32) NOT NULL DEFAULT 'review_required',
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_content_fingerprint VARCHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'learning_files_approval_status_check'
      AND conrelid = 'public.learning_files'::regclass
  ) THEN
    ALTER TABLE public.learning_files
      ADD CONSTRAINT learning_files_approval_status_check
      CHECK (approval_status IN ('review_required', 'approved', 'legacy_active'));
  END IF;
END $$;

-- Existing active content stays active without changing its questions or
-- publication history. Newly staged content remains explicitly review_required.
UPDATE public.learning_files
SET approval_status = 'legacy_active'
WHERE (published = true OR publish_status = 'active')
  AND approval_status = 'review_required';

CREATE INDEX IF NOT EXISTS learning_files_approval_status_index
  ON public.learning_files (approval_status, published, publish_status);

CREATE INDEX IF NOT EXISTS learning_files_approved_by_index
  ON public.learning_files (approved_by)
  WHERE approved_by IS NOT NULL;
