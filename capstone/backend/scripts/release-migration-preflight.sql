\set ON_ERROR_STOP on
\set migration_024_review_required false

-- Supply expected_database, expected_role, expected_server_address, and
-- expected_server_port with psql -v values taken from the approved change record.
-- Use a dedicated role with direct SELECT grants only; this script refuses
-- superuser/admin roles and roles with persistent write privileges.
\if :{?expected_database}
\else
  \echo 'STOP: -v expected_database is required.'
  SELECT 'preflight stopped: expected_database is required'::integer;
\endif
\if :{?expected_role}
\else
  \echo 'STOP: -v expected_role is required.'
  SELECT 'preflight stopped: expected_role is required'::integer;
\endif
\if :{?expected_server_address}
\else
  \echo 'STOP: -v expected_server_address is required.'
  SELECT 'preflight stopped: expected_server_address is required'::integer;
\endif
\if :{?expected_server_port}
\else
  \echo 'STOP: -v expected_server_port is required.'
  SELECT 'preflight stopped: expected_server_port is required'::integer;
\endif

BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

SELECT current_database() AS database_name,
       current_user AS database_role,
       host(inet_server_addr()) AS server_address,
       inet_server_port() AS server_port,
       current_setting('server_version') AS server_version,
       current_setting('transaction_read_only') AS transaction_read_only;

SELECT current_database() = :'expected_database'
         AND current_user = :'expected_role'
         AND session_user = current_user
         AND host(inet_server_addr()) = :'expected_server_address'
         AND inet_server_port() = :'expected_server_port'::integer
         AND current_setting('transaction_read_only') = 'on' AS target_identity_ok
\gset
\if :target_identity_ok
  \echo 'Target database identity and read-only transaction match the approved values.'
\else
  \echo 'STOP: target database identity or read-only transaction does not match the approved values.'
  SELECT 'preflight stopped: target database identity or read-only transaction mismatch'::integer;
\endif

WITH role_checks AS (
  SELECT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_roles AS role_record
         WHERE role_record.rolname = current_user
           AND NOT role_record.rolsuper
           AND NOT role_record.rolcreatedb
           AND NOT role_record.rolcreaterole
           AND NOT role_record.rolreplication
           AND NOT role_record.rolbypassrls
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_auth_members AS membership
             WHERE membership.member = role_record.oid
           )
       ) AS role_is_non_admin,
       NOT has_database_privilege(current_user, current_database(), 'CREATE') AS database_create_denied,
       NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_namespace AS namespace_record
         WHERE namespace_record.nspname <> 'information_schema'
           AND namespace_record.nspname !~ '^pg_'
           AND has_schema_privilege(current_user, namespace_record.oid, 'CREATE')
       ) AS schema_create_denied,
       NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS relation_namespace
           ON relation_namespace.oid = relation.relnamespace
         WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND relation_namespace.nspname <> 'information_schema'
           AND relation_namespace.nspname !~ '^pg_'
           AND (
             has_table_privilege(current_user, relation.oid, 'INSERT')
             OR has_table_privilege(current_user, relation.oid, 'UPDATE')
             OR has_table_privilege(current_user, relation.oid, 'DELETE')
             OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
             OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
             OR has_table_privilege(current_user, relation.oid, 'TRIGGER')
           )
       ) AS table_write_privileges_denied,
       NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS sequence_relation
         JOIN pg_catalog.pg_namespace AS sequence_namespace
           ON sequence_namespace.oid = sequence_relation.relnamespace
         WHERE sequence_relation.relkind = 'S'
           AND sequence_namespace.nspname <> 'information_schema'
           AND sequence_namespace.nspname !~ '^pg_'
           AND (
             has_sequence_privilege(current_user, sequence_relation.oid, 'USAGE')
             OR has_sequence_privilege(current_user, sequence_relation.oid, 'UPDATE')
           )
       ) AS sequence_write_privileges_denied
), role_summary AS (
  SELECT *,
         role_is_non_admin
           AND database_create_denied
           AND schema_create_denied
           AND table_write_privileges_denied
           AND sequence_write_privileges_denied AS role_read_only_ok
  FROM role_checks
)
SELECT role_is_non_admin, database_create_denied, schema_create_denied,
       table_write_privileges_denied, sequence_write_privileges_denied,
       role_read_only_ok
FROM role_summary
\gset
\echo Read-only role audit: non_admin=:role_is_non_admin database_create_denied=:database_create_denied schema_create_denied=:schema_create_denied table_write_denied=:table_write_privileges_denied sequence_write_denied=:sequence_write_privileges_denied
\if :role_read_only_ok
  \echo 'Database role is non-admin and has no persistent write privileges on application schemas.'
\else
  \echo 'STOP: expected a dedicated non-admin read-only database role.'
  SELECT 'preflight stopped: database role is not dedicated and read-only'::integer;
\endif

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
  ('playtime_deletion_tombstones')
) AS objects(object_name)
ORDER BY object_name;

SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger_present \gset
\if :ledger_present
  \echo 'Migration ledger exists.'
\else
  \echo 'STOP: schema_migrations is absent. Reconcile migration history; no ledger was created.'
  SELECT 'preflight stopped: schema_migrations is absent'::integer;
\endif

WITH ledger_columns AS (
  SELECT attname,
         pg_catalog.format_type(atttypid, atttypmod) AS formatted_type,
         attnotnull,
         attnum,
         EXISTS (
           SELECT 1 FROM pg_catalog.pg_attrdef AS default_record
           WHERE default_record.adrelid = attribute_record.attrelid
             AND default_record.adnum = attribute_record.attnum
         ) AS has_default
  FROM pg_catalog.pg_attribute AS attribute_record
  WHERE attrelid = 'public.schema_migrations'::regclass
    AND attnum > 0
    AND NOT attisdropped
), ledger_primary_key AS (
  SELECT constraint_record.conkey = ARRAY[version_column.attnum]::smallint[] AS version_is_only_primary_key
  FROM pg_catalog.pg_constraint AS constraint_record
  CROSS JOIN ledger_columns AS version_column
  WHERE constraint_record.conrelid = 'public.schema_migrations'::regclass
    AND constraint_record.contype = 'p'
    AND version_column.attname = 'version'
)
SELECT COUNT(*) = 4
       AND BOOL_AND(
         (attname = 'version' AND formatted_type = 'integer' AND attnotnull)
         OR (attname = 'filename' AND formatted_type = 'character varying(255)' AND attnotnull)
         OR (attname = 'checksum' AND formatted_type = 'character(64)' AND attnotnull)
         OR (attname = 'applied_at' AND formatted_type = 'timestamp with time zone' AND attnotnull AND has_default)
       )
       AND (SELECT COUNT(*) = 1 AND BOOL_AND(version_is_only_primary_key) FROM ledger_primary_key)
       AS migration_ledger_shape_ok
FROM ledger_columns
\gset
\if :migration_ledger_shape_ok
  \echo 'Migration ledger columns and version primary key are valid.'
\else
  \echo 'STOP: schema_migrations has an incompatible or incomplete shape.'
  SELECT 'preflight stopped: schema_migrations shape is incompatible'::integer;
\endif

-- A missing ledger row is reported as PENDING, never inferred as already applied.
WITH expected(version, filename, source_sha256) AS (
  VALUES
    (18, '018_website_sessions_and_audit_metadata.sql', 'f64e6e0de7abdf873fdb1bc93739d2704e4b16ed5bc428c991c7507407ea5668'),
    (19, '019_playtime_history_removal.sql', 'b76fa5f58daae29dbcf2120b4c9ff533eda3c41dc3f21efdab93b207fb8b2f4f'),
    (20, '020_add_auth_otp_challenge_security.sql', '6e2cf94b9a8acdcee728e8a0283a95580fc7e63f6622dcb5890415f4b9e715af'),
    (21, '021_canonical_milestones_and_activity_contract.sql', '3b5ff42ba45a158df434b92b95e935c608fc0a236516d8135d6d0329963beac6'),
    (22, '022_game_telemetry_contract.sql', '5a45ef2133bc0d69fe117f7164eeb9af65eb16bcf6f4a1215804bd14919e3c76'),
    (23, '023_quest_evidence_and_playtime_tombstones.sql', '2df0959d48efd554a8e7403ebbf331bfdfb6971b2d66e43a6ae267c02642f12d'),
    (24, '024_remove_legacy_six_digit_students.sql', '2595a35fe97699376b611f21cc19aa4b7e26d495463fe7585bf7e1c96370e111'),
    (25, '025_add_game_result_question_traceability.sql', '2a1b904056274c73903cfb713703c6db8e6c2ea37f9c8fd1863f9a3004e42e68')
)
SELECT e.version,
       e.filename AS expected_filename,
       e.source_sha256 AS expected_source_sha256,
       m.filename AS ledger_filename,
       m.checksum AS ledger_sha256,
       m.applied_at,
       CASE
         WHEN m.version IS NULL THEN 'PENDING'
         WHEN m.filename IS DISTINCT FROM e.filename THEN 'STOP_FILENAME_MISMATCH'
         WHEN LOWER(BTRIM(COALESCE(m.checksum, ''))) <> e.source_sha256 THEN 'STOP_CHECKSUM_MISMATCH'
         ELSE 'APPLIED_CHECKSUM_MATCH'
       END AS preflight_state
FROM expected AS e
LEFT JOIN public.schema_migrations AS m ON m.version = e.version
ORDER BY e.version;

WITH expected(version, filename, source_sha256) AS (
  VALUES
    (18, '018_website_sessions_and_audit_metadata.sql', 'f64e6e0de7abdf873fdb1bc93739d2704e4b16ed5bc428c991c7507407ea5668'),
    (19, '019_playtime_history_removal.sql', 'b76fa5f58daae29dbcf2120b4c9ff533eda3c41dc3f21efdab93b207fb8b2f4f'),
    (20, '020_add_auth_otp_challenge_security.sql', '6e2cf94b9a8acdcee728e8a0283a95580fc7e63f6622dcb5890415f4b9e715af'),
    (21, '021_canonical_milestones_and_activity_contract.sql', '3b5ff42ba45a158df434b92b95e935c608fc0a236516d8135d6d0329963beac6'),
    (22, '022_game_telemetry_contract.sql', '5a45ef2133bc0d69fe117f7164eeb9af65eb16bcf6f4a1215804bd14919e3c76'),
    (23, '023_quest_evidence_and_playtime_tombstones.sql', '2df0959d48efd554a8e7403ebbf331bfdfb6971b2d66e43a6ae267c02642f12d'),
    (24, '024_remove_legacy_six_digit_students.sql', '2595a35fe97699376b611f21cc19aa4b7e26d495463fe7585bf7e1c96370e111'),
    (25, '025_add_game_result_question_traceability.sql', '2a1b904056274c73903cfb713703c6db8e6c2ea37f9c8fd1863f9a3004e42e68')
)
SELECT EXISTS (
  SELECT 1
  FROM expected AS e
  JOIN public.schema_migrations AS m ON m.version = e.version
  WHERE m.filename IS DISTINCT FROM e.filename
     OR LOWER(BTRIM(COALESCE(m.checksum, ''))) IS DISTINCT FROM e.source_sha256
) AS migration_metadata_mismatch \gset
\if :migration_metadata_mismatch
  \echo 'STOP: applied migration filename or checksum differs from reviewed source.'
  SELECT 'preflight stopped: migration filename or checksum mismatch'::integer;
\endif

SELECT EXISTS (
  SELECT 1 FROM public.schema_migrations WHERE version > 25
) AS newer_migration_present \gset
\if :newer_migration_present
  \echo 'STOP: database ledger contains a version newer than this source.'
  SELECT 'preflight stopped: database migration ledger is newer than this source'::integer;
\endif

-- The checksums above are tied to migrations 018-025 in this PR's source tree.
-- Migration 026 is intentionally excluded until PR #31 is integrated.

-- Compare the runtime startup contract against every required table/column.
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
  ('playtime_sessions', 'deleted_at'),
  ('playtime_sessions', 'deleted_by'),
  ('playtime_sessions', 'deletion_operation_id'),
  ('playtime_sessions', 'deletion_reason'),
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
) AS startup_schema_preflight,
NOT EXISTS (SELECT 1 FROM missing) AS startup_schema_ready
\gset
\echo Startup schema result: :startup_schema_preflight
\if :startup_schema_ready
  \echo 'Startup schema contract is complete: 17 tables and 269 required columns are present.'
\else
  \echo 'STOP: one or more required tables or columns are missing; do not deploy this source.'
  SELECT 'preflight stopped: required startup table or column is missing'::integer;
\endif

-- Catalog details below contain schema metadata only, not application row values.
SELECT table_name, column_name, data_type, udt_name, is_nullable,
       character_maximum_length, numeric_precision, numeric_scale, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'accounts', 'activity_logs', 'admin_audit_logs', 'announcements', 'folders',
    'game_results', 'learning_files', 'login_otp_device_skips',
    'playtime_deletion_tombstones', 'playtime_sessions', 'questions',
    'student_ai_insights', 'student_game_progress', 'student_quest_milestones',
    'teacher_class_assignments', 'teacher_student_relationships', 'website_sessions'
  )
ORDER BY table_name, ordinal_position;

WITH expected_types(table_name, column_name, expected_data_type) AS (
  VALUES
    ('accounts', 'id', 'integer'),
    ('accounts', 'game_student_id', 'character varying'),
    ('accounts', 'current_learning_cycle_version', 'integer'),
    ('accounts', 'session_version', 'integer'),
    ('activity_logs', 'id', 'integer'),
    ('activity_logs', 'student_id', 'integer'),
    ('activity_logs', 'activity_timestamp', 'timestamp with time zone'),
    ('game_results', 'id', 'integer'),
    ('game_results', 'resolved_student_id', 'integer'),
    ('game_results', 'response_time_seconds', 'integer'),
    ('student_game_progress', 'id', 'integer'),
    ('student_game_progress', 'student_id', 'integer'),
    ('student_ai_insights', 'id', 'integer'),
    ('student_ai_insights', 'student_id', 'integer'),
    ('student_ai_insights', 'insight', 'jsonb'),
    ('learning_files', 'id', 'integer'),
    ('learning_files', 'source_file_bytes', 'bytea'),
    ('playtime_sessions', 'id', 'integer'),
    ('playtime_sessions', 'learning_cycle_version', 'integer'),
    ('playtime_sessions', 'deleted_at', 'timestamp with time zone'),
    ('playtime_sessions', 'deleted_by', 'integer'),
    ('playtime_sessions', 'deletion_operation_id', 'uuid'),
    ('playtime_sessions', 'deletion_reason', 'character varying')
), type_mismatches AS (
  SELECT e.table_name, e.column_name, e.expected_data_type, c.data_type AS actual_data_type
  FROM expected_types AS e
  LEFT JOIN information_schema.columns AS c
    ON c.table_schema = 'public'
   AND c.table_name = e.table_name
   AND c.column_name = e.column_name
  WHERE c.column_name IS NULL OR c.data_type <> e.expected_data_type
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'table', table_name,
         'column', column_name,
         'expected_type', expected_data_type,
         'actual_type', actual_data_type
       ) ORDER BY table_name, column_name), '[]'::jsonb) AS core_type_mismatches,
       NOT EXISTS (SELECT 1 FROM type_mismatches) AS core_types_compatible
FROM type_mismatches
\gset
\echo Core type compatibility: :core_type_mismatches
\if :core_types_compatible
  \echo 'Core type checks passed.'
\else
  \echo 'STOP: one or more core column types do not match the source contract.'
  SELECT 'preflight stopped: required core column type mismatch'::integer;
\endif

SELECT COALESCE((
         SELECT data_type = 'character varying' AND character_maximum_length = 8
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'accounts'
           AND column_name = 'game_student_id'
       ), false) AS game_student_id_width_ok
\gset
\if :game_student_id_width_ok
  \echo 'accounts.game_student_id is VARCHAR(8), as required by migration 017.'
\else
  \echo 'STOP: accounts.game_student_id must be VARCHAR(8) as required by migration 017.'
  SELECT 'preflight stopped: accounts.game_student_id must be VARCHAR(8)'::integer;
\endif

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
JOIN pg_catalog.pg_class AS relation ON relation.oid = c.conrelid
JOIN pg_catalog.pg_namespace AS schema_namespace ON schema_namespace.oid = relation.relnamespace
WHERE schema_namespace.nspname = 'public'
  AND relation.relname IN (
    'accounts', 'activity_logs', 'admin_audit_logs', 'announcements', 'folders',
    'game_results', 'learning_files', 'login_otp_device_skips',
    'playtime_deletion_tombstones', 'playtime_sessions', 'questions',
    'student_ai_insights', 'student_game_progress', 'student_quest_milestones',
    'teacher_class_assignments', 'teacher_student_relationships', 'website_sessions'
  )
ORDER BY table_name, c.conname;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'accounts', 'activity_logs', 'admin_audit_logs', 'announcements', 'folders',
    'game_results', 'learning_files', 'login_otp_device_skips',
    'playtime_deletion_tombstones', 'playtime_sessions', 'questions',
    'student_ai_insights', 'student_game_progress', 'student_quest_milestones',
    'teacher_class_assignments', 'teacher_student_relationships', 'website_sessions'
  )
ORDER BY tablename, indexname;

SELECT relation.relname AS table_name,
       trigger_record.tgname AS trigger_name,
       trigger_record.tgenabled,
       pg_get_triggerdef(trigger_record.oid) AS definition
FROM pg_catalog.pg_trigger AS trigger_record
JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
JOIN pg_catalog.pg_namespace AS schema_namespace ON schema_namespace.oid = relation.relnamespace
WHERE schema_namespace.nspname = 'public'
  AND NOT trigger_record.tgisinternal
  AND relation.relname IN (
    'accounts', 'activity_logs', 'admin_audit_logs', 'announcements', 'folders',
    'game_results', 'learning_files', 'login_otp_device_skips',
    'playtime_deletion_tombstones', 'playtime_sessions', 'questions',
    'student_ai_insights', 'student_game_progress', 'student_quest_milestones',
    'teacher_class_assignments', 'teacher_student_relationships', 'website_sessions'
  )
ORDER BY relation.relname, trigger_record.tgname;

SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_trigger AS trigger_record
  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
  JOIN pg_catalog.pg_namespace AS schema_namespace ON schema_namespace.oid = relation.relnamespace
  WHERE schema_namespace.nspname = 'public'
    AND relation.relname = 'teacher_class_assignments'
    AND trigger_record.tgname = 'teacher_class_assignments_validate_teacher'
    AND NOT trigger_record.tgisinternal
    AND trigger_record.tgenabled <> 'D'
) AS teacher_assignment_trigger_ready \gset
\if :teacher_assignment_trigger_ready
  \echo 'Teacher-class assignment validation trigger is enabled.'
\else
  \echo 'STOP: required teacher-class assignment validation trigger is missing or disabled.'
  SELECT 'preflight stopped: teacher-class-assignment trigger is missing or disabled'::integer;
\endif

SELECT NOT EXISTS (
  SELECT 1 FROM public.schema_migrations WHERE version = 24
) AS migration_024_pending \gset
\if :migration_024_pending
  \set migration_024_review_required true
  SELECT to_regclass('public.accounts') IS NOT NULL AS accounts_present,
         to_regclass('public.game_results') IS NOT NULL AS game_results_present,
         to_regclass('public.playtime_sessions') IS NOT NULL AS playtime_sessions_present \gset
  \if :accounts_present
    \if :game_results_present
      \if :playtime_sessions_present
        \echo 'Migration 024 direct count-only impact follows; no identifiers are selected.'
      \else
        \echo 'STOP: playtime_sessions is absent while migration 024 is pending.'
        SELECT 'preflight stopped: playtime_sessions is absent while migration 024 is pending'::integer;
      \endif
    \else
      \echo 'STOP: game_results is absent while migration 024 is pending.'
      SELECT 'preflight stopped: game_results is absent while migration 024 is pending'::integer;
    \endif
  \else
    \echo 'STOP: accounts is absent while migration 024 is pending.'
    SELECT 'preflight stopped: accounts is absent while migration 024 is pending'::integer;
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

  -- Emit a COUNT(*) query for every direct FK into the three relations whose
  -- rows migration 024 deletes. This captures database-specific CASCADE,
  -- SET NULL, SET DEFAULT, and restrictive edges without exposing row values.
  -- For a referencing row that is itself explicitly deleted, do not count it
  -- as a surviving SET NULL/SET DEFAULT update.
  SELECT format(
    'SELECT %L AS foreign_key_edge, %L AS on_delete, COUNT(*) AS affected_rows FROM %s AS child JOIN %s AS parent ON %s WHERE %s%s;',
    child_namespace.nspname || '.' || child_relation.relname || '.' || constraint_record.conname,
    CASE constraint_record.confdeltype
      WHEN 'a' THEN 'NO ACTION'
      WHEN 'r' THEN 'RESTRICT'
      WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'
      WHEN 'd' THEN 'SET DEFAULT'
    END,
    child_relation.oid::regclass,
    parent_relation.oid::regclass,
    join_columns.join_predicate,
    CASE parent_relation.relname
      WHEN 'accounts' THEN 'LOWER(parent.role) = ''student'' AND BTRIM(COALESCE(parent.game_student_id, '''')) ~ ''^[0-9]{6}$'''
      WHEN 'game_results' THEN 'parent.resolved_student_id IN (SELECT id FROM public.accounts WHERE LOWER(role) = ''student'' AND BTRIM(COALESCE(game_student_id, '''')) ~ ''^[0-9]{6}$'')'
      WHEN 'playtime_sessions' THEN 'parent.student_id IN (SELECT id FROM public.accounts WHERE LOWER(role) = ''student'' AND BTRIM(COALESCE(game_student_id, '''')) ~ ''^[0-9]{6}$'')'
    END,
    CASE child_relation.relname
      WHEN 'accounts' THEN ' AND NOT (LOWER(child.role) = ''student'' AND BTRIM(COALESCE(child.game_student_id, '''')) ~ ''^[0-9]{6}$'')'
      WHEN 'game_results' THEN ' AND NOT (child.resolved_student_id IN (SELECT id FROM public.accounts WHERE LOWER(role) = ''student'' AND BTRIM(COALESCE(game_student_id, '''')) ~ ''^[0-9]{6}$''))'
      WHEN 'playtime_sessions' THEN ' AND NOT (child.student_id IN (SELECT id FROM public.accounts WHERE LOWER(role) = ''student'' AND BTRIM(COALESCE(game_student_id, '''')) ~ ''^[0-9]{6}$''))'
      ELSE ''
    END
  )
  FROM pg_catalog.pg_constraint AS constraint_record
  JOIN pg_catalog.pg_class AS child_relation ON child_relation.oid = constraint_record.conrelid
  JOIN pg_catalog.pg_namespace AS child_namespace ON child_namespace.oid = child_relation.relnamespace
  JOIN pg_catalog.pg_class AS parent_relation ON parent_relation.oid = constraint_record.confrelid
  JOIN LATERAL (
    SELECT string_agg(
      format('child.%I = parent.%I', child_column.attname, parent_column.attname),
      ' AND ' ORDER BY key_column.position
    ) AS join_predicate
    FROM unnest(constraint_record.conkey, constraint_record.confkey)
         WITH ORDINALITY AS key_column(child_attnum, parent_attnum, position)
    JOIN pg_catalog.pg_attribute AS child_column
      ON child_column.attrelid = constraint_record.conrelid
     AND child_column.attnum = key_column.child_attnum
    JOIN pg_catalog.pg_attribute AS parent_column
      ON parent_column.attrelid = constraint_record.confrelid
     AND parent_column.attnum = key_column.parent_attnum
  ) AS join_columns ON true
  WHERE constraint_record.contype = 'f'
    AND constraint_record.confrelid IN (
      'public.accounts'::regclass,
      'public.game_results'::regclass,
      'public.playtime_sessions'::regclass
    )
  ORDER BY child_namespace.nspname, child_relation.relname, constraint_record.conname
  \gexec

  -- Inventory all direct FK edges and recursively reachable CASCADE edges. A
  -- graph deeper than one level, or any edge without reviewed count coverage,
  -- requires a separate count-only operator query before approval.
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
\if :migration_024_review_required
  \echo 'STOP: migration 024 is pending. These counts are a preflight input only; complete and approve every recursive cascade/SET NULL impact before any migration run.'
  SELECT 'preflight stopped: migration 024 is pending and requires separate impact approval'::integer;
\endif
