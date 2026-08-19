-- The parent-owned child profile stores school metadata separately from
-- gameplay metrics. Existing accounts and game progress remain unchanged.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS middle_initial VARCHAR(5),
  ADD COLUMN IF NOT EXISTS grade_level VARCHAR(20),
  ADD COLUMN IF NOT EXISTS section VARCHAR(50);

-- game_student_id and the canonical Parent/Student relationship already have
-- unique constraints/indexes; no duplicate relationship or Student-ID index
-- is introduced here.
