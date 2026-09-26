BEGIN;

CREATE TEMP TABLE legacy_six_digit_students ON COMMIT DROP AS
SELECT id
FROM public.accounts
WHERE LOWER(role) = 'student'
  AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$';

DELETE FROM public.game_results
WHERE resolved_student_id IN (SELECT id FROM legacy_six_digit_students);

DELETE FROM public.playtime_sessions
WHERE student_id IN (SELECT id FROM legacy_six_digit_students);

DELETE FROM public.accounts
WHERE id IN (SELECT id FROM legacy_six_digit_students)
  AND LOWER(role) = 'student'
  AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$';

COMMIT;
