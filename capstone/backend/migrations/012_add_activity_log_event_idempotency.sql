-- Canonical Godot quest events are retried by the client after transport
-- failures. Keep a nullable event key so historical activity remains intact,
-- while one Student cannot receive the same canonical event twice.
ALTER TABLE public.activity_logs
  ADD COLUMN IF NOT EXISTS event_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS activity_logs_student_event_key_unique
  ON public.activity_logs (student_id, event_key)
  WHERE event_key IS NOT NULL;
