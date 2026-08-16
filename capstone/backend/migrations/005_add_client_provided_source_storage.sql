-- Preserve the exact bundled source file inside PostgreSQL when an explicitly
-- approved Client Provided import occurs. This removes any dependency on the
-- operator's workstation after import and gives the importer a durable,
-- duplicate-safe content fingerprint.
ALTER TABLE public.learning_files
  ADD COLUMN IF NOT EXISTS source_content_fingerprint VARCHAR(64),
  ADD COLUMN IF NOT EXISTS source_file_bytes BYTEA,
  ADD COLUMN IF NOT EXISTS source_file_mime_type VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_files_client_provided_fingerprint
  ON public.learning_files (source_content_fingerprint)
  WHERE source_content_fingerprint IS NOT NULL
    AND source IN ('restored_import', 'client_provided');
