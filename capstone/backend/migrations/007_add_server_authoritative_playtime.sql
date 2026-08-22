-- Daily-playtime leases are created and elapsed exclusively from PostgreSQL
-- server time. The credential is a one-way hash; plaintext credentials are
-- returned only once to the running game client and are never persisted.
ALTER TABLE public.playtime_sessions
  ADD COLUMN IF NOT EXISTS total_playtime_seconds INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS server_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS session_credential_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_playtime_sessions_expiry
  ON public.playtime_sessions(status, expires_at);

ALTER TABLE public.game_results
  ADD COLUMN IF NOT EXISTS playtime_session_id INTEGER
    REFERENCES public.playtime_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_game_results_playtime_session_id
  ON public.game_results(playtime_session_id);
