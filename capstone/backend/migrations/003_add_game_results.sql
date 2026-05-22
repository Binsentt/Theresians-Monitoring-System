-- Keep per-session quiz results separate from existing aggregate game progress records.
CREATE TABLE IF NOT EXISTS public.game_results (
  id SERIAL PRIMARY KEY,
  parent_id CHARACTER VARYING(6) NOT NULL,
  student_name CHARACTER VARYING(100) NOT NULL,
  resolved_student_id INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
  grade_level CHARACTER VARYING(20),
  difficulty CHARACTER VARYING(20),
  math_topic CHARACTER VARYING(255),
  score INTEGER NOT NULL,
  total_items INTEGER NOT NULL,
  percentage DECIMAL(5, 2) NOT NULL,
  played_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  is_unlinked BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_game_results_parent_id
  ON public.game_results(parent_id);

CREATE INDEX IF NOT EXISTS idx_game_results_resolved_student_id
  ON public.game_results(resolved_student_id);
