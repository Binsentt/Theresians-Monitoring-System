-- Keep the source question set for new per-question Godot results.
-- Nullable by design: older Godot clients and pre-migration rows remain valid.
-- A restrictive foreign key preserves historical identifiers and prevents a
-- concurrent permanent delete from orphaning a newly saved result. It never
-- cascades or nulls historical data.
ALTER TABLE public.game_results
  ADD COLUMN IF NOT EXISTS question_set_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_game_results_question_set_id
  ON public.game_results(question_set_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'game_results_question_set_id_fkey'
      AND conrelid = 'public.game_results'::regclass
  ) THEN
    ALTER TABLE public.game_results
      ADD CONSTRAINT game_results_question_set_id_fkey
      FOREIGN KEY (question_set_id)
      REFERENCES public.learning_files(id)
      ON DELETE RESTRICT;
  END IF;
END $$;
