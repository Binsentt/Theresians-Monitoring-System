-- A reset starts a new current learning cycle without deleting historical
-- game results, playtime sessions, activity history, or canonical identity.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS current_learning_cycle_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_accounts_learning_cycle_boundary
  ON public.accounts(id, current_learning_cycle_started_at);

-- Keep the account that initiated a reset as an auditable canonical reference.
ALTER TABLE public.activity_logs
  ADD COLUMN IF NOT EXISTS actor_account_id INTEGER
    REFERENCES public.accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_activity_logs_actor_account_id
  ON public.activity_logs(actor_account_id);
