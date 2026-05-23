-- Add nullable difficulty metadata for Lesson & Question Manager records.
-- Existing learning files and questions remain valid when difficulty is unknown.

ALTER TABLE public.learning_files
  ADD COLUMN IF NOT EXISTS difficulty VARCHAR(20);

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS difficulty VARCHAR(20);

DROP INDEX IF EXISTS public.idx_learning_files_grade_topic;
DROP INDEX IF EXISTS public.idx_questions_grade_topic;

CREATE INDEX IF NOT EXISTS idx_learning_files_grade_difficulty_topic
  ON public.learning_files(grade_level, difficulty, math_topic);

CREATE INDEX IF NOT EXISTS idx_questions_grade_difficulty_topic
  ON public.questions(grade_level, difficulty, math_topic);
