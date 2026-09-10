BEGIN;

ALTER TABLE public.admin_audit_logs
  ADD COLUMN IF NOT EXISTS before_metadata JSONB;

ALTER TABLE public.admin_audit_logs
  ADD COLUMN IF NOT EXISTS after_metadata JSONB;

CREATE TABLE IF NOT EXISTS public.website_sessions (
  id BIGSERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  credential_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason VARCHAR(100),
  CONSTRAINT website_sessions_expiry_after_creation_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS website_sessions_account_presence_index
  ON public.website_sessions (account_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS website_sessions_expiry_index
  ON public.website_sessions (expires_at)
  WHERE revoked_at IS NULL;

COMMIT;
