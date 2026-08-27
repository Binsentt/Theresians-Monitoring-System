-- Fixed-question source documents can describe multiple Mathematics topics.
-- Preserve that human-readable description separately from the one controlled
-- game-publication topic. Existing historical topics remain unchanged.
ALTER TABLE public.learning_files
  ADD COLUMN IF NOT EXISTS document_topic TEXT;

-- A multi-topic source has no safe single encounter scope until a future
-- deterministic review resolves one. NULL prevents accidental publication.
ALTER TABLE public.learning_files
  ALTER COLUMN math_topic DROP NOT NULL;
