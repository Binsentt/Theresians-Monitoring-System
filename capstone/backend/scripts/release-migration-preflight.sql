\set ON_ERROR_STOP on

-- Run with a dedicated read-only role. No row-level identifiers are selected.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

SELECT current_database() AS database_name,
       current_user AS database_user,
       inet_server_addr()::text AS server_address,
       inet_server_port() AS server_port,
       current_setting('server_version') AS server_version,
       current_setting('transaction_read_only') AS transaction_read_only;

SELECT object_name,
       to_regclass(format('public.%I', object_name))::text AS relation_name
FROM (VALUES
  ('schema_migrations'),
  ('accounts'),
  ('game_results'),
  ('playtime_sessions'),
  ('activity_logs'),
  ('website_sessions'),
  ('student_quest_milestones'),
  ('playtime_deletion_tombstones'),
  ('game_progress_save_commits')
) AS objects(object_name)
ORDER BY object_name;

SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger_present \gset
\if :ledger_present
  \echo 'Migration ledger exists.'
\else
  \echo 'STOP: schema_migrations is absent. Reconcile migration history; no ledger was created.'
  \quit 3
\endif

-- A missing ledger row is reported as PENDING, never inferred as already applied.
WITH expected(version, filename) AS (
  VALUES
    (18, '018_website_sessions_and_audit_metadata.sql'),
    (19, '019_playtime_history_removal.sql'),
    (20, '020_add_auth_otp_challenge_security.sql'),
    (21, '021_canonical_milestones_and_activity_contract.sql'),
    (22, '022_game_telemetry_contract.sql'),
    (23, '023_quest_evidence_and_playtime_tombstones.sql'),
    (24, '024_remove_legacy_six_digit_students.sql'),
    (25, '025_add_game_result_question_traceability.sql'),
    (26, '026_game_progress_save_commit_idempotency.sql')
)
SELECT e.version,
       e.filename AS expected_filename,
       m.filename AS ledger_filename,
       m.checksum AS ledger_sha256,
       m.applied_at,
       CASE
         WHEN m.version IS NULL THEN 'PENDING'
         WHEN m.filename <> e.filename THEN 'STOP_FILENAME_MISMATCH'
         ELSE 'APPLIED_COMPARE_CHECKSUM_TO_SOURCE'
       END AS preflight_state
FROM expected AS e
LEFT JOIN public.schema_migrations AS m ON m.version = e.version
ORDER BY e.version;

WITH expected(version, filename) AS (
  VALUES
    (18, '018_website_sessions_and_audit_metadata.sql'),
    (19, '019_playtime_history_removal.sql'),
    (20, '020_add_auth_otp_challenge_security.sql'),
    (21, '021_canonical_milestones_and_activity_contract.sql'),
    (22, '022_game_telemetry_contract.sql'),
    (23, '023_quest_evidence_and_playtime_tombstones.sql'),
    (24, '024_remove_legacy_six_digit_students.sql'),
    (25, '025_add_game_result_question_traceability.sql'),
    (26, '026_game_progress_save_commit_idempotency.sql')
)
SELECT EXISTS (
  SELECT 1
  FROM expected AS e
  JOIN public.schema_migrations AS m ON m.version = e.version
  WHERE m.filename <> e.filename
) AS filename_mismatch \gset
\if :filename_mismatch
  \echo 'STOP: migration filename mismatch; do not approve a migration.'
  \quit 3
\endif

SELECT EXISTS (
  SELECT 1 FROM public.schema_migrations WHERE version > 26
) AS newer_migration_present \gset
\if :newer_migration_present
  \echo 'STOP: database ledger contains a version newer than this source.'
  \quit 3
\endif

-- Compare each applied checksum with SHA-256 of the exact SQL source file at
-- the reviewed commit. The script reports ledger values only.
SELECT table_name, column_name, data_type, udt_name, is_nullable,
       character_maximum_length, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('accounts', 'activity_logs', 'game_progress_save_commits')
ORDER BY table_name, ordinal_position;

+-- Compare the runtime startup contract against every required table/column.
-- This reports schema metadata and counts only; no application rows are read.
WITH required_columns(table_name, column_name) AS (
  VALUES
  ('accounts', 'address'),
  ('accounts', 'birthday'),
  ('accounts', 'created_at'),
  ('accounts', 'current_learning_cycle_started_at'),
  ('accounts', 'current_learning_cycle_version'),
  ('accounts', 'email'),
  ('accounts', 'employee_id'),
  ('accounts', 'first_name'),
  ('accounts', 'game_student_id'),
  ('accounts', 'gender'),
  ('accounts', 'grade_level'),
  ('accounts', 'id'),
  ('accounts', 'is_archived'),
  ('accounts', 'last_name'),
  ('accounts', 'middle_initial'),
  ('accounts', 'mobile_number'),
  ('accounts', 'must_change_password'),
  ('accounts', 'name'),
  ('accounts', 'otp_code'),
  ('accounts', 'otp_expires_at'),
  ('accounts', 'parent_id'),
  ('accounts', 'password'),
  ('accounts', 'progress_archive_reason'),
  ('accounts', 'progress_archived_at'),
  ('accounts', 'progress_archived_by'),
  ('accounts', 'role'),
  ('accounts', 'screen_time_reset_at'),
  ('accounts', 'section'),
  ('accounts', 'session_version'),
  ('accounts', 'status'),
  ('accounts', 'temporary_password_expires_at'),
  ('accounts', 'temporary_password_issued_at'),
  ('activity_logs', 'activity_description'),
  ('activity_logs', 'activity_event_id'),
  ('activity_logs', 'activity_timestamp'),
  ('activity_logs', 'actor_account_id'),
  ('activity_logs', 'canonical_activity_id'),
  ('activity_logs', 'canonical_milestone_id'),
  ('activity_logs', 'canonical_quest_id'),
  ('activity_logs', 'canonical_task_id'),
  ('activity_logs', 'completed_at'),
  ('activity_logs', 'created_at'),
  ('activity_logs', 'current_map'),
  ('activity_logs', 'current_quest'),
  ('activity_logs', 'current_scene'),
  ('activity_logs', 'difficulty_level'),
  ('activity_logs', 'duration_seconds'),
  ('activity_logs', 'grade_level'),
  ('activity_logs', 'id'),
  ('activity_logs', 'is_player_facing'),
  ('activity_logs', 'last_played'),
  ('activity_logs', 'lesson_progress'),
  ('activity_logs', 'login_time'),
  ('activity_logs', 'logout_time'),
  ('activity_logs', 'map_id'),
  ('activity_logs', 'quest_graph_version'),
  ('activity_logs', 'quest_progress'),
  ('activity_logs', 'role'),
  ('activity_logs', 'save_status'),
  ('activity_logs', 'section'),
  ('activity_logs', 'session_date'),
  ('activity_logs', 'session_id'),
  ('activity_logs', 'started_at'),
  ('activity_logs', 'status'),
  ('activity_logs', 'student_id'),
  ('activity_logs', 'student_name'),
  ('activity_logs', 'telemetry_contract_version'),
  ('activity_logs', 'total_play_time'),
  ('admin_audit_logs', 'action'),
  ('admin_audit_logs', 'admin_account_id'),
  ('admin_audit_logs', 'admin_name'),
  ('admin_audit_logs', 'after_metadata'),
  ('admin_audit_logs', 'before_metadata'),
  ('admin_audit_logs', 'created_at'),
  ('admin_audit_logs', 'id'),
  ('admin_audit_logs', 'operation_type'),
  ('admin_audit_logs', 'reason'),
  ('admin_audit_logs', 'target_account_id'),
  ('admin_audit_logs', 'target_user'),
  ('announcements', 'created_at'),
  ('announcements', 'created_by'),
  ('announcements', 'created_by_role'),
  ('announcements', 'id'),
  ('announcements', 'message'),
  ('announcements', 'target_role'),
  ('announcements', 'title'),
  ('folders', 'created_at'),
  ('folders', 'deleted_at'),
  ('folders', 'id'),
  ('folders', 'name'),
  ('folders', 'trashed_at'),
  ('game_results', 'answer_submitted_at'),
  ('game_results', 'canonical_battle_id'),
  ('game_results', 'canonical_milestone_id'),
  ('game_results', 'canonical_quest_id'),
  ('game_results', 'canonical_task_id'),
  ('game_results', 'current_map'),
  ('game_results', 'difficulty'),
  ('game_results', 'grade_level'),
  ('game_results', 'id'),
  ('game_results', 'is_unlinked'),
  ('game_results', 'map_id'),
  ('game_results', 'math_topic'),
  ('game_results', 'parent_id'),
  ('game_results', 'percentage'),
  ('game_results', 'played_at'),
  ('game_results', 'playtime_session_id'),
  ('game_results', 'quest_graph_version'),
  ('game_results', 'question_id'),
  ('game_results', 'question_presented_at'),
  ('game_results', 'question_set_id'),
  ('game_results', 'resolved_student_id'),
  ('game_results', 'response_time_seconds'),
  ('game_results', 'result_event_id'),
  ('game_results', 'score'),
  ('game_results', 'session_id'),
  ('game_results', 'student_name'),
  ('game_results', 'telemetry_contract_version'),
  ('game_results', 'total_items'),
  ('learning_files', 'content_role'),
  ('learning_files', 'deleted_at'),
  ('learning_files', 'difficulty'),
  ('learning_files', 'document_topic'),
  ('learning_files', 'file_name'),
  ('learning_files', 'file_size'),
  ('learning_files', 'file_type'),
  ('learning_files', 'file_url'),
  ('learning_files', 'folder_id'),
  ('learning_files', 'generated_at'),
  ('learning_files', 'generation_completed_count'),
  ('learning_files', 'generation_error_code'),
  ('learning_files', 'generation_failed_at'),
  ('learning_files', 'generation_failed_batch_index'),
  ('learning_files', 'generation_remaining_count'),
  ('learning_files', 'generation_retry_count'),
  ('learning_files', 'generation_stage'),
  ('learning_files', 'generation_status'),
  ('learning_files', 'grade_level'),
  ('learning_files', 'id'),
  ('learning_files', 'last_fetched_at'),
  ('learning_files', 'math_topic'),
  ('learning_files', 'publish_status'),
  ('learning_files', 'published'),
  ('learning_files', 'published_at'),
  ('learning_files', 'published_by'),
  ('learning_files', 'requested_question_count'),
  ('learning_files', 'source'),
  ('learning_files', 'source_content_fingerprint'),
  ('learning_files', 'source_file_bytes'),
  ('learning_files', 'source_file_mime_type'),
  ('learning_files', 'source_learning_file_id'),
  ('learning_files', 'subject'),
  ('learning_files', 'title'),
  ('learning_files', 'topic_id'),
  ('learning_files', 'trashed_at'),
  ('learning_files', 'uploaded_at'),
  ('learning_files', 'uploaded_by'),
  ('login_otp_device_skips', 'created_at'),
  ('login_otp_device_skips', 'device_id'),
  ('login_otp_device_skips', 'id'),
  ('login_otp_device_skips', 'otp_skipped_until'),
  ('login_otp_device_skips', 'updated_at'),
  ('login_otp_device_skips', 'user_id'),
  ('playtime_deletion_tombstones', 'deleted_at'),
  ('playtime_deletion_tombstones', 'deleted_by'),
  ('playtime_deletion_tombstones', 'deleted_record_id'),
  ('playtime_deletion_tombstones', 'deletion_operation_id'),
  ('playtime_deletion_tombstones', 'deletion_reason'),
  ('playtime_deletion_tombstones', 'id'),
  ('playtime_deletion_tombstones', 'target_fingerprint'),
  ('playtime_sessions', 'created_at'),
  ('playtime_sessions', 'date_played'),
  ('playtime_sessions', 'end_time'),
  ('playtime_sessions', 'expires_at'),
  ('playtime_sessions', 'grade_level'),
  ('playtime_sessions', 'id'),
  ('playtime_sessions', 'last_heartbeat_at'),
  ('playtime_sessions', 'learning_cycle_version'),
  ('playtime_sessions', 'parent_id'),
  ('playtime_sessions', 'section'),
  ('playtime_sessions', 'server_started_at'),
  ('playtime_sessions', 'session_credential_hash'),
  ('playtime_sessions', 'start_time'),
  ('playtime_sessions', 'status'),
  ('playtime_sessions', 'student_id'),
  ('playtime_sessions', 'student_name'),
  ('playtime_sessions', 'total_playtime_minutes'),
  ('playtime_sessions', 'total_playtime_seconds'),
  ('playtime_sessions', 'updated_at'),
  ('questions', 'correct_answer'),
  ('questions', 'created_at'),
  ('questions', 'difficulty'),
  ('questions', 'grade_level'),
  ('questions', 'id'),
  ('questions', 'learning_file_id'),
  ('questions', 'math_topic'),
  ('questions', 'options'),
  ('questions', 'published'),
  ('questions', 'question'),
  ('questions', 'source'),
  ('questions', 'topic_id'),
  ('questions', 'updated_at'),
  ('student_ai_insights', 'generated_at'),
  ('student_ai_insights', 'generated_by'),
  ('student_ai_insights', 'id'),
  ('student_ai_insights', 'input_fingerprint'),
  ('student_ai_insights', 'insight'),
  ('student_ai_insights', 'stale_at'),
  ('student_ai_insights', 'student_id'),
  ('student_ai_insights', 'updated_at'),
  ('student_game_progress', 'accuracy_rate'),
  ('student_game_progress', 'correct_answers'),
  ('student_game_progress', 'created_at'),
  ('student_game_progress', 'current_map'),
  ('student_game_progress', 'current_quest'),
  ('student_game_progress', 'current_scene'),
  ('student_game_progress', 'difficulty_level'),
  ('student_game_progress', 'grade_level'),
  ('student_game_progress', 'id'),
  ('student_game_progress', 'last_played'),
  ('student_game_progress', 'lesson_progress'),
  ('student_game_progress', 'progress_percentage'),
  ('student_game_progress', 'score'),
  ('student_game_progress', 'section'),
  ('student_game_progress', 'student_id'),
  ('student_game_progress', 'student_name'),
  ('student_game_progress', 'total_play_time'),
  ('student_game_progress', 'total_questions'),
  ('student_game_progress', 'total_quests_completed'),
  ('student_game_progress', 'updated_at'),
  ('student_quest_milestones', 'canonical_milestone_id'),
  ('student_quest_milestones', 'canonical_quest_id'),
  ('student_quest_milestones', 'canonical_task_id'),
  ('student_quest_milestones', 'completed_at'),
  ('student_quest_milestones', 'id'),
  ('student_quest_milestones', 'learning_cycle_version'),
  ('student_quest_milestones', 'map_id'),
  ('student_quest_milestones', 'milestone_id'),
  ('student_quest_milestones', 'player_facing'),
  ('student_quest_milestones', 'quest_graph_version'),
  ('student_quest_milestones', 'source_activity_event_id'),
  ('student_quest_milestones', 'student_id'),
  ('student_quest_milestones', 'telemetry_contract_version'),
  ('student_quest_milestones', 'weight'),
  ('teacher_class_assignments', 'created_at'),
  ('teacher_class_assignments', 'created_by_admin'),
  ('teacher_class_assignments', 'grade_level'),
  ('teacher_class_assignments', 'id'),
  ('teacher_class_assignments', 'section'),
  ('teacher_class_assignments', 'section_key'),
  ('teacher_class_assignments', 'teacher_account_id'),
  ('teacher_class_assignments', 'updated_at'),
  ('teacher_student_relationships', 'created_at'),
  ('teacher_student_relationships', 'id'),
  ('teacher_student_relationships', 'relationship_type'),
  ('teacher_student_relationships', 'student_id'),
  ('teacher_student_relationships', 'teacher_id'),
  ('website_sessions', 'account_id'),
  ('website_sessions', 'created_at'),
  ('website_sessions', 'credential_hash'),
  ('website_sessions', 'expires_at'),
  ('website_sessions', 'id'),
  ('website_sessions', 'last_seen_at'),
  ('website_sessions', 'revocation_reason'),
  ('website_sessions', 'revoked_at')
), schema_contract AS (
  SELECT required_columns.table_name, required_columns.column_name,
         relation.oid AS relation_oid, column_definition.attnum AS column_attnum
  FROM required_columns
  LEFT JOIN pg_catalog.pg_namespace AS schema_namespace ON schema_namespace.nspname = 'public'
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.relnamespace = schema_namespace.oid
   AND relation.relname = required_columns.table_name
   AND relation.relkind IN ('r', 'p')
  LEFT JOIN pg_catalog.pg_attribute AS column_definition
    ON column_definition.attrelid = relation.oid
   AND column_definition.attname = required_columns.column_name
   AND column_definition.attnum > 0
   AND column_definition.attisdropped = false
), missing AS (
  SELECT DISTINCT CASE WHEN relation_oid IS NULL THEN table_name
                       ELSE table_name || '.' || column_name END AS missing_object
  FROM schema_contract
  WHERE relation_oid IS NULL OR column_attnum IS NULL
)
SELECT jsonb_build_object(
  'missing_tables', (SELECT COUNT(DISTINCT table_name) FROM schema_contract WHERE relation_oid IS NULL),
  'missing_columns', (SELECT COUNT(*) FROM schema_contract WHERE relation_oid IS NOT NULL AND column_attnum IS NULL),
  'present_required_columns', (SELECT COUNT(*) FROM schema_contract WHERE column_attnum IS NOT NULL),
  'total_required_columns', (SELECT COUNT(*) FROM schema_contract),
  'missing_objects', COALESCE((SELECT jsonb_agg(missing_object ORDER BY missing_object) FROM missing), '[]'::jsonb)
) AS startup_schema_preflight;

-- Any nonzero missing count or any returned missing_object is a stop condition.

SELECT c.conrelid::regclass::text AS table_name,
       c.conname,
       CASE c.contype
         WHEN 'p' THEN 'PRIMARY KEY'
         WHEN 'u' THEN 'UNIQUE'
         WHEN 'f' THEN 'FOREIGN KEY'
         WHEN 'c' THEN 'CHECK'
         ELSE c.contype::text
       END AS constraint_type,
       c.convalidated,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint AS c
WHERE c.conrelid = ANY (ARRAY[
  to_regclass('public.accounts')::oid,
  to_regclass('public.activity_logs')::oid,
  to_regclass('public.game_progress_save_commits')::oid
])
ORDER BY table_name, c.conname;

SELECT EXISTS (
         SELECT 1 FROM public.schema_migrations WHERE version = 26
       ) AS migration_026_applied,
       to_regclass('public.accounts') IS NOT NULL AS accounts_present,
       to_regclass('public.activity_logs') IS NOT NULL AS activity_logs_present,
       to_regclass('public.game_progress_save_commits') IS NOT NULL AS receipts_present \gset
\if :migration_026_applied
  \if :receipts_present
    \echo 'Migration 026 is recorded and the receipt table exists; review its complete shape above.'
  \else
    \echo 'STOP: migration 026 is recorded but its receipt table is absent.'
    \quit 3
  \endif
\else
  \if :accounts_present
    \if :activity_logs_present
      \echo 'Migration 026 prerequisite tables are present; compare their columns to migration 026.'
    \else
      \echo 'STOP: activity_logs is absent while migration 026 is not recorded.'
      \quit 3
    \endif
  \else
    \echo 'STOP: accounts is absent while migration 026 is not recorded.'
    \quit 3
  \endif
\endif

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('activity_logs', 'game_progress_save_commits')
ORDER BY tablename, indexname;

SELECT NOT EXISTS (
  SELECT 1 FROM public.schema_migrations WHERE version = 24
) AS migration_024_pending \gset
\if :migration_024_pending
  SELECT to_regclass('public.accounts') IS NOT NULL AS accounts_present,
         to_regclass('public.game_results') IS NOT NULL AS game_results_present,
         to_regclass('public.playtime_sessions') IS NOT NULL AS playtime_sessions_present \gset
  \if :accounts_present
    \if :game_results_present
      \if :playtime_sessions_present
        \echo 'Migration 024 direct count-only impact follows; no identifiers are selected.'
      \else
        \echo 'STOP: playtime_sessions is absent while migration 024 is pending.'
        \quit 3
      \endif
    \else
      \echo 'STOP: game_results is absent while migration 024 is pending.'
      \quit 3
    \endif
  \else
    \echo 'STOP: accounts is absent while migration 024 is pending.'
    \quit 3
  \endif

  WITH candidates AS (
    SELECT id
    FROM public.accounts
    WHERE LOWER(role) = 'student'
      AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'
  )
  SELECT 'accounts (direct delete)' AS impact, COUNT(*) AS row_count
  FROM candidates
  UNION ALL
  SELECT 'game_results.resolved_student_id (direct delete)', COUNT(*)
  FROM public.game_results AS gr
  JOIN candidates AS c ON c.id = gr.resolved_student_id
  UNION ALL
  SELECT 'playtime_sessions.student_id (direct delete)', COUNT(*)
  FROM public.playtime_sessions AS ps
  JOIN candidates AS c ON c.id = ps.student_id;

  SELECT to_regclass('public.website_sessions') IS NOT NULL AS website_sessions_present,
         to_regclass('public.student_quest_milestones') IS NOT NULL AS milestones_present,
         to_regclass('public.game_progress_save_commits') IS NOT NULL AS receipts_present,
         to_regclass('public.playtime_deletion_tombstones') IS NOT NULL AS tombstones_present \gset
  \if :website_sessions_present
    WITH candidates AS (
      SELECT id FROM public.accounts
      WHERE LOWER(role) = 'student'
        AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'
    )
    SELECT 'website_sessions.account_id (CASCADE)' AS impact, COUNT(*) AS row_count
    FROM public.website_sessions AS ws
    JOIN candidates AS c ON c.id = ws.account_id;
  \endif
  \if :milestones_present
    WITH candidates AS (
      SELECT id FROM public.accounts
      WHERE LOWER(role) = 'student'
        AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'
    )
    SELECT 'student_quest_milestones.student_id (CASCADE)' AS impact, COUNT(*) AS row_count
    FROM public.student_quest_milestones AS sqm
    JOIN candidates AS c ON c.id = sqm.student_id;
  \endif
  \if :receipts_present
    WITH candidates AS (
      SELECT id FROM public.accounts
      WHERE LOWER(role) = 'student'
        AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'
    )
    SELECT 'game_progress_save_commits.student_id (CASCADE)' AS impact, COUNT(*) AS row_count
    FROM public.game_progress_save_commits AS sc
    JOIN candidates AS c ON c.id = sc.student_id;
  \endif
  \if :tombstones_present
    WITH candidates AS (
      SELECT id FROM public.accounts
      WHERE LOWER(role) = 'student'
        AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'
    )
    SELECT 'playtime_deletion_tombstones.deleted_by (SET NULL)' AS impact, COUNT(*) AS row_count
    FROM public.playtime_deletion_tombstones AS t
    JOIN candidates AS c ON c.id = t.deleted_by;
  \endif
  \if :playtime_sessions_present
    WITH candidates AS (
      SELECT id FROM public.accounts
      WHERE LOWER(role) = 'student'
        AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'
    )
    SELECT 'playtime_sessions.deleted_by (SET NULL; not directly deleted)' AS impact,
           COUNT(*) AS row_count
    FROM public.playtime_sessions AS ps
    JOIN candidates AS deleter ON deleter.id = ps.deleted_by
    WHERE NOT EXISTS (
      SELECT 1 FROM candidates AS direct_delete
      WHERE direct_delete.id = ps.student_id
    );
  \endif

  -- Inventory every direct FK into tables explicitly deleted by migration 024
  -- and every recursive CASCADE. Count-only joins are still needed for any
  -- additional database-specific edges listed below.
  SELECT confrelid::regclass::text AS referenced_parent,
         conrelid::regclass::text AS referencing_child,
         conname,
         CASE confdeltype
           WHEN 'a' THEN 'NO ACTION'
           WHEN 'r' THEN 'RESTRICT'
           WHEN 'c' THEN 'CASCADE'
           WHEN 'n' THEN 'SET NULL'
           WHEN 'd' THEN 'SET DEFAULT'
         END AS on_delete,
         pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE contype = 'f'
    AND confrelid IN (
      'public.accounts'::regclass,
      'public.game_results'::regclass,
      'public.playtime_sessions'::regclass
    )
  ORDER BY referenced_parent, referencing_child, conname;

  WITH RECURSIVE cascade_edges(parent_oid, child_oid, constraint_oid, depth, path) AS (
    SELECT c.confrelid, c.conrelid, c.oid, 1,
           ARRAY[c.confrelid, c.conrelid]::oid[]
    FROM pg_constraint AS c
    WHERE c.contype = 'f'
      AND c.confdeltype = 'c'
      AND c.confrelid IN (
        'public.accounts'::regclass,
        'public.game_results'::regclass,
        'public.playtime_sessions'::regclass
      )
    UNION ALL
    SELECT c.confrelid, c.conrelid, c.oid, e.depth + 1,
           array_append(e.path, c.conrelid)
    FROM cascade_edges AS e
    JOIN pg_constraint AS c
      ON c.contype = 'f'
     AND c.confdeltype = 'c'
     AND c.confrelid = e.child_oid
    WHERE NOT c.conrelid = ANY(e.path)
  )
  SELECT DISTINCT e.depth,
         e.parent_oid::regclass::text AS parent_table,
         e.child_oid::regclass::text AS child_table,
         c.conname,
         pg_get_constraintdef(c.oid) AS definition
  FROM cascade_edges AS e
  JOIN pg_constraint AS c ON c.oid = e.constraint_oid
  ORDER BY e.depth, parent_table, child_table, c.conname;
\else
  \echo 'Migration 024 is already recorded; no 024 deletion counts were run.'
\endif

ROLLBACK;
