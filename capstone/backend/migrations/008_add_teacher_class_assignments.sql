-- Authoritative, admin-managed class assignments. These rows grant teacher
-- monitoring scope by canonical student grade/section without duplicating
-- parent-child or student identity records.
CREATE TABLE IF NOT EXISTS public.teacher_class_assignments (
  id SERIAL PRIMARY KEY,
  teacher_account_id INTEGER NOT NULL
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  grade_level VARCHAR(20) NOT NULL
    CHECK (grade_level IN ('Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6')),
  section VARCHAR(50) NOT NULL
    CHECK (section = BTRIM(section) AND CHAR_LENGTH(section) > 0),
  section_key VARCHAR(50) NOT NULL
    CHECK (section_key = LOWER(REGEXP_REPLACE(BTRIM(section), '[[:space:]]+', ' ', 'g'))),
  created_by_admin INTEGER
    REFERENCES public.accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT teacher_class_assignments_unique
    UNIQUE (teacher_account_id, grade_level, section_key)
);

CREATE INDEX IF NOT EXISTS idx_teacher_class_assignments_teacher
  ON public.teacher_class_assignments(teacher_account_id);

CREATE INDEX IF NOT EXISTS idx_teacher_class_assignments_scope
  ON public.teacher_class_assignments(grade_level, section_key);

CREATE OR REPLACE FUNCTION public.validate_teacher_class_assignment_teacher()
RETURNS TRIGGER AS $$
DECLARE
  target_role TEXT;
  target_archived BOOLEAN;
BEGIN
  SELECT LOWER(role), COALESCE(is_archived, false)
    INTO target_role, target_archived
  FROM public.accounts
  WHERE id = NEW.teacher_account_id;

  IF NOT FOUND OR target_archived OR target_role NOT IN ('teacher', 'parent_teacher') THEN
    RAISE EXCEPTION 'Teacher class assignments require an active Teacher or Parent/Teacher account.';
  END IF;

  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'teacher_class_assignments_validate_teacher'
      AND tgrelid = 'public.teacher_class_assignments'::regclass
  ) THEN
    CREATE TRIGGER teacher_class_assignments_validate_teacher
      BEFORE INSERT OR UPDATE ON public.teacher_class_assignments
      FOR EACH ROW
      EXECUTE FUNCTION public.validate_teacher_class_assignment_teacher();
  END IF;
END;
$$;
