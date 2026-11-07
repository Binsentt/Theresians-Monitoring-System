-- Run inside the same REPEATABLE READ, READ ONLY transaction as both queries.
-- Bind $1 = authorized internal Student account ID; $2 = expected current cycle.
-- First check to_regclass('public.schema_migrations') outside this statement;
-- do not execute this statement if the migration ledger is absent.
WITH required_columns(table_name, column_name) AS (
  VALUES
    ('accounts', 'id'), ('accounts', 'role'), ('accounts', 'is_archived'),
    ('accounts', 'current_learning_cycle_version'), ('accounts', 'current_learning_cycle_started_at'),
    ('game_results', 'resolved_student_id'), ('game_results', 'score'), ('game_results', 'total_items'),
    ('game_results', 'played_at'), ('game_results', 'grade_level'), ('game_results', 'difficulty'),
    ('game_results', 'question_id'), ('game_results', 'question_set_id'),
    ('game_results', 'session_id'), ('game_results', 'playtime_session_id'),
    ('playtime_sessions', 'id'), ('playtime_sessions', 'student_id'), ('playtime_sessions', 'learning_cycle_version'),
    ('learning_files', 'id'), ('learning_files', 'grade_level'), ('learning_files', 'difficulty'),
    ('learning_files', 'topic_id'), ('learning_files', 'math_topic'),
    ('questions', 'id'), ('questions', 'learning_file_id'), ('questions', 'grade_level'),
    ('questions', 'difficulty'), ('questions', 'topic_id'), ('questions', 'math_topic'),
    ('schema_migrations', 'version'), ('schema_migrations', 'filename')
), required_access AS (
  SELECT BOOL_AND(CASE WHEN c.column_name IS NULL THEN false
                       ELSE has_column_privilege(current_user,
                         FORMAT('public.%I', rc.table_name), rc.column_name, 'SELECT')
                  END) AS has_select
  FROM required_columns rc
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = rc.table_name
   AND c.column_name = rc.column_name
), column_inventory AS (
  SELECT COUNT(*)::BIGINT AS present_count
  FROM required_columns rc
  JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = rc.table_name
   AND c.column_name = rc.column_name
), target AS (
  SELECT a.id, COALESCE(a.current_learning_cycle_version, 0) AS cycle_version
  FROM public.accounts a
  WHERE a.id = $1::INTEGER
    AND LOWER(a.role) = 'student'
    AND COALESCE(a.is_archived, false) = false
    AND COALESCE(a.current_learning_cycle_version, 0) >= 0
    AND $2::INTEGER >= 0
), required_tables AS (
  SELECT DISTINCT table_name FROM required_columns
), write_privileges AS (
  SELECT COALESCE(BOOL_AND(CASE
    WHEN to_regclass(FORMAT('public.%I', table_name)) IS NULL THEN false
    ELSE NOT (
      has_table_privilege(current_user, FORMAT('public.%I', table_name), 'INSERT') OR
      has_table_privilege(current_user, FORMAT('public.%I', table_name), 'UPDATE') OR
      has_table_privilege(current_user, FORMAT('public.%I', table_name), 'DELETE') OR
      has_table_privilege(current_user, FORMAT('public.%I', table_name), 'TRUNCATE') OR
      has_any_column_privilege(current_user, FORMAT('public.%I', table_name), 'INSERT') OR
      has_any_column_privilege(current_user, FORMAT('public.%I', table_name), 'UPDATE')
    )
  END), false) AS no_table_write_privileges
  FROM required_tables
), diagnostic_role AS (
  SELECT NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
         AND NOT r.rolreplication AND NOT r.rolbypassrls AS is_nonprivileged
  FROM pg_roles r
  WHERE r.rolname = current_user
)
SELECT
  current_setting('transaction_read_only') = 'on' AS read_only_transaction,
  (SELECT COUNT(*) FROM target)::BIGINT AS scope_match_count,
  (SELECT COUNT(*) FROM target WHERE cycle_version = $2::INTEGER)::BIGINT AS cycle_parameter_match_count,
  (SELECT COUNT(*) FROM public.schema_migrations
   WHERE version = 25 AND filename = '025_add_game_result_question_traceability.sql')::BIGINT AS migration_025_count,
  (SELECT present_count FROM column_inventory) AS required_columns_present_count,
  COALESCE((SELECT has_select FROM required_access), false) AS required_select_columns,
  (SELECT COUNT(*) FROM pg_constraint
   WHERE conrelid = to_regclass('public.game_results')
     AND convalidated
     AND ((conname = 'game_results_question_set_question_fkey' AND contype = 'f')
       OR (conname = 'game_results_question_requires_set_check' AND contype = 'c')))::BIGINT AS migration_025_valid_constraint_count,
  (SELECT COUNT(*) FROM pg_indexes
   WHERE schemaname = 'public'
     AND ((tablename = 'game_results' AND indexname = 'idx_game_results_question_id')
       OR (tablename = 'questions' AND indexname = 'questions_id_learning_file_id_unique')))::BIGINT
    AS migration_025_required_index_count,
  (SELECT no_table_write_privileges FROM write_privileges) AS no_table_write_privileges,
  CASE WHEN to_regnamespace('public') IS NULL THEN false
       ELSE has_schema_privilege(current_user, 'public', 'USAGE') END AS public_schema_usage,
  CASE WHEN to_regnamespace('public') IS NULL THEN false
       ELSE NOT has_schema_privilege(current_user, 'public', 'CREATE') END AS no_public_schema_create,
  COALESCE((SELECT is_nonprivileged FROM diagnostic_role), false) AS role_is_nonprivileged;
