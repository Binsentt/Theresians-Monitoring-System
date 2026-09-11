ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS otp_code_hash VARCHAR(128),
  ADD COLUMN IF NOT EXISTS otp_purpose VARCHAR(40),
  ADD COLUMN IF NOT EXISTS otp_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS otp_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS otp_challenge_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_otp_challenge_id_key
  ON public.accounts(otp_challenge_id)
  WHERE otp_challenge_id IS NOT NULL;
