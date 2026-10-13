ALTER TABLE public.game_results
  ADD COLUMN IF NOT EXISTS question_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_game_results_question_id
  ON public.game_results(question_id)
  WHERE question_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS questions_id_learning_file_id_unique
  ON public.questions(id, learning_file_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'game_results_question_set_question_fkey'
      AND conrelid = 'public.game_results'::regclass
  ) THEN
    ALTER TABLE public.game_results
      ADD CONSTRAINT game_results_question_set_question_fkey
      FOREIGN KEY (question_id, question_set_id)
      REFERENCES public.questions(id, learning_file_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'game_results_question_requires_set_check'
      AND conrelid = 'public.game_results'::regclass
  ) THEN
    ALTER TABLE public.game_results
      ADD CONSTRAINT game_results_question_requires_set_check
      CHECK (question_id IS NULL OR question_set_id IS NOT NULL);
  END IF;
END $$;
