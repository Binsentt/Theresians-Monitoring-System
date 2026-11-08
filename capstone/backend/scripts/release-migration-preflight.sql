\set ON_ERROR_STOP on

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
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';

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
    (18, '018_website_sessions_and_audit_metadata.sql', '14286fcc83e3137c3885c65c5003641c797c79d74b025cee37da740e2f72096d'),
    (19, '019_playtime_history_removal.sql', '41945e69be335a60c78c3b1ea50bcd5e589ded0a7f5493706ae33331358ef9a8'),
    (20, '020_add_auth_otp_challenge_security.sql', 'f732c73b072ec4cb54e3fa0d616fa32a669164d971b23f38b4b003f2b5c63fb8'),
    (21, '021_canonical_milestones_and_activity_contract.sql', '6e34dcc1b256fdd5ba00bdd443409c9151c37b6a0d09870e0dc48986785082a9'),
    (22, '022_game_telemetry_contract.sql', '04581b2704b1042992dda6f2d2918fd3d540190a584481300e3e33953a7153d0'),
    (23, '023_quest_evidence_and_playtime_tombstones.sql', '99c13e6aa1535748b1a9c6dd1602073e2d7ac61103a7a0bf25cd8434ae2dfc70'),
    (24, '024_remove_legacy_six_digit_students.sql', 'a909547e51912782f912c95dcc61701dbf796192dd8fff6dd3dd3175faaf9563'),
    (25, '025_add_game_result_question_traceability.sql', '9b4f86791793c7bfacb02fdcef69d6723742d7bb196aab1cd9eb4d15d80ec410'),
    (26, '026_game_progress_save_commit_idempotency.sql', 'ff1a3141d87d4783cdd3be3690c8cc0b524f06e896ec489b8f54a9dad07d73af')
)
SELECT e.version,
       e.filename AS expected_filename,
       e.source_sha256 AS expected_source_sha256,
       m.filename AS ledger_filename,
       m.checksum AS ledger_sha256,
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
    (18, '018_website_sessions_and_audit_metadata.sql', '14286fcc83e3137c3885c65c5003641c797c79d74b025cee37da740e2f72096d'),
    (19, '019_playtime_history_removal.sql', '41945e69be335a60c78c3b1ea50bcd5e589ded0a7f5493706ae33331358ef9a8'),
    (20, '020_add_auth_otp_challenge_security.sql', 'f732c73b072ec4cb54e3fa0d616fa32a669164d971b23f38b4b003f2b5c63fb8'),
    (21, '021_canonical_milestones_and_activity_contract.sql', '6e34dcc1b256fdd5ba00bdd443409c9151c37b6a0d09870e0dc48986785082a9'),
    (22, '022_game_telemetry_contract.sql', '04581b2704b1042992dda6f2d2918fd3d540190a584481300e3e33953a7153d0'),
    (23, '023_quest_evidence_and_playtime_tombstones.sql', '99c13e6aa1535748b1a9c6dd1602073e2d7ac61103a7a0bf25cd8434ae2dfc70'),
    (24, '024_remove_legacy_six_digit_students.sql', 'a909547e51912782f912c95dcc61701dbf796192dd8fff6dd3dd3175faaf9563'),
    (25, '025_add_game_result_question_traceability.sql', '9b4f86791793c7bfacb02fdcef69d6723742d7bb196aab1cd9eb4d15d80ec410'),
    (26, '026_game_progress_save_commit_idempotency.sql', 'ff1a3141d87d4783cdd3be3690c8cc0b524f06e896ec489b8f54a9dad07d73af')
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
  SELECT 1 FROM public.schema_migrations WHERE version > 26
) AS newer_migration_present \gset
\if :newer_migration_present
  \echo 'STOP: database ledger contains a version newer than this source.'
  SELECT 'preflight stopped: database migration ledger is newer than this source'::integer;
\endif

-- Destructive migration 024 is outside this metadata-only preflight. Stop
-- immediately after validating the ledger; any impact analysis is separate.
SELECT NOT EXISTS (
  SELECT 1 FROM public.schema_migrations WHERE version = 24
) AS migration_024_pending \gset
\if :migration_024_pending
  \echo 'STOP: destructive migration 024 is pending. Separate impact review and approval are required; this preflight does not query application rows or apply migrations.'
  ROLLBACK;
  SELECT 'preflight stopped: destructive migration 024 is pending and requires separate impact review and approval'::integer;
\endif

-- The checksums above are tied to migrations 018-026 in this source tree.

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
  ('game_progress_save_commits', 'activity_event_key'),
  ('game_progress_save_commits', 'completed_at'),
  ('game_progress_save_commits', 'created_at'),
  ('game_progress_save_commits', 'learning_cycle_version'),
  ('game_progress_save_commits', 'payload_sha256'),
  ('game_progress_save_commits', 'response_body'),
  ('game_progress_save_commits', 'response_status'),
  ('game_progress_save_commits', 'save_commit_id_hash'),
  ('game_progress_save_commits', 'student_id'),
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
  \echo 'Startup schema contract is complete: 18 tables and 278 required columns are present.'
\else
  \echo 'STOP: one or more required tables or columns are missing; do not deploy this source.'
  SELECT 'preflight stopped: required startup table or column is missing'::integer;
\endif

-- Catalog details below contain schema metadata only, not application row values.
SELECT relation_record.relname AS table_name,
       attribute_record.attname AS column_name,
       pg_catalog.format_type(type_record.oid, NULL) AS data_type,
       type_record.typname AS udt_name,
       CASE WHEN attribute_record.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
       CASE
         WHEN type_record.typname IN ('varchar', 'bpchar') AND attribute_record.atttypmod >= 4
           THEN attribute_record.atttypmod - 4
         ELSE NULL
       END AS character_maximum_length,
       CASE
         WHEN type_record.typname = 'numeric' AND attribute_record.atttypmod >= 4
           THEN ((attribute_record.atttypmod - 4) >> 16) & 65535
         WHEN type_record.typname = 'int2' THEN 16
         WHEN type_record.typname = 'int4' THEN 32
         WHEN type_record.typname = 'int8' THEN 64
         WHEN type_record.typname = 'float4' THEN 24
         WHEN type_record.typname = 'float8' THEN 53
         ELSE NULL
       END AS numeric_precision,
       CASE
         WHEN type_record.typname = 'numeric' AND attribute_record.atttypmod >= 4
           THEN (((attribute_record.atttypmod - 4) & 2047) # 1024) - 1024
         WHEN type_record.typname IN ('int2', 'int4', 'int8') THEN 0
         ELSE NULL
       END AS numeric_scale,
       pg_catalog.pg_get_expr(default_record.adbin, default_record.adrelid) AS column_default
FROM pg_catalog.pg_namespace AS namespace_record
JOIN pg_catalog.pg_class AS relation_record
  ON relation_record.relnamespace = namespace_record.oid
JOIN pg_catalog.pg_attribute AS attribute_record
  ON attribute_record.attrelid = relation_record.oid
JOIN pg_catalog.pg_type AS type_record
  ON type_record.oid = attribute_record.atttypid
LEFT JOIN pg_catalog.pg_attrdef AS default_record
  ON default_record.adrelid = relation_record.oid
 AND default_record.adnum = attribute_record.attnum
WHERE namespace_record.nspname = 'public'
  AND relation_record.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute_record.attnum > 0
  AND NOT attribute_record.attisdropped
  AND relation_record.relname IN (
    'accounts', 'activity_logs', 'admin_audit_logs', 'announcements', 'folders',
    'game_progress_save_commits', 'game_results', 'learning_files', 'login_otp_device_skips',
    'playtime_deletion_tombstones', 'playtime_sessions', 'questions',
    'student_ai_insights', 'student_game_progress', 'student_quest_milestones',
    'teacher_class_assignments', 'teacher_student_relationships', 'website_sessions'
  )
ORDER BY table_name, attribute_record.attnum;

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
    ('game_progress_save_commits', 'student_id', 'integer'),
    ('game_progress_save_commits', 'learning_cycle_version', 'integer'),
    ('game_progress_save_commits', 'save_commit_id_hash', 'text'),
    ('game_progress_save_commits', 'payload_sha256', 'text'),
    ('game_progress_save_commits', 'activity_event_key', 'text'),
    ('game_progress_save_commits', 'response_status', 'smallint'),
    ('game_progress_save_commits', 'response_body', 'jsonb'),
    ('game_progress_save_commits', 'created_at', 'timestamp with time zone'),
    ('game_progress_save_commits', 'completed_at', 'timestamp with time zone'),
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
  SELECT e.table_name,
         e.column_name,
         e.expected_data_type,
         pg_catalog.format_type(type_record.oid, NULL) AS actual_data_type
  FROM expected_types AS e
  LEFT JOIN pg_catalog.pg_namespace AS namespace_record
    ON namespace_record.nspname = 'public'
  LEFT JOIN pg_catalog.pg_class AS relation_record
    ON relation_record.relnamespace = namespace_record.oid
   AND relation_record.relname = e.table_name
   AND relation_record.relkind IN ('r', 'p', 'v', 'm', 'f')
  LEFT JOIN pg_catalog.pg_attribute AS attribute_record
    ON attribute_record.attrelid = relation_record.oid
   AND attribute_record.attname = e.column_name
   AND attribute_record.attnum > 0
   AND NOT attribute_record.attisdropped
  LEFT JOIN pg_catalog.pg_type AS type_record
    ON type_record.oid = attribute_record.atttypid
  WHERE attribute_record.attname IS NULL
     OR type_record.oid IS NULL
     OR pg_catalog.format_type(type_record.oid, NULL) IS DISTINCT FROM e.expected_data_type
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

WITH required_receipt_constraints(constraint_name, constraint_type) AS (
  VALUES
    ('game_progress_save_commits_pkey', 'p'),
    ('game_progress_save_commits_activity_event_unique', 'u'),
    ('game_progress_save_commits_student_id_fkey', 'f'),
    ('game_progress_save_commits_learning_cycle_version_check', 'c'),
    ('game_progress_save_commits_save_commit_id_hash_check', 'c'),
    ('game_progress_save_commits_payload_sha256_check', 'c'),
    ('game_progress_save_commits_response_status_check', 'c'),
    ('game_progress_save_commits_completion_consistency', 'c')
)
SELECT NOT EXISTS (
  SELECT 1
  FROM required_receipt_constraints AS expected
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.relnamespace = 'public'::regnamespace
   AND relation.relname = 'game_progress_save_commits'
   AND relation.relkind IN ('r', 'p')
  LEFT JOIN pg_catalog.pg_constraint AS constraint_record
    ON constraint_record.conrelid = relation.oid
   AND constraint_record.conname = expected.constraint_name
  WHERE relation.oid IS NULL
     OR constraint_record.oid IS NULL
     OR constraint_record.contype::text <> expected.constraint_type
     OR NOT constraint_record.convalidated
     OR (expected.constraint_name = 'game_progress_save_commits_student_id_fkey'
         AND (constraint_record.confdeltype <> 'c'
              OR constraint_record.confrelid <> 'public.accounts'::regclass))
) AS receipt_constraints_ready \gset
\if :receipt_constraints_ready
  \echo 'Migration 026 receipt keys, checks, and student cascade are present and validated.'
\else
  \echo 'STOP: migration 026 receipt constraints are missing or incompatible.'
  SELECT 'preflight stopped: migration 026 receipt constraints are missing or incompatible'::integer;
\endif

SELECT COALESCE((
         SELECT type_record.oid = 'pg_catalog.varchar'::regtype
                AND attribute_record.atttypmod = 8 + 4
                AND pg_catalog.format_type(type_record.oid, attribute_record.atttypmod) = 'character varying(8)'
         FROM pg_catalog.pg_namespace AS namespace_record
         JOIN pg_catalog.pg_class AS relation_record
           ON relation_record.relnamespace = namespace_record.oid
         JOIN pg_catalog.pg_attribute AS attribute_record
           ON attribute_record.attrelid = relation_record.oid
         JOIN pg_catalog.pg_type AS type_record
           ON type_record.oid = attribute_record.atttypid
         WHERE namespace_record.nspname = 'public'
           AND relation_record.relname = 'accounts'
           AND relation_record.relkind IN ('r', 'p')
           AND attribute_record.attname = 'game_student_id'
           AND attribute_record.attnum > 0
           AND NOT attribute_record.attisdropped
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
    'game_progress_save_commits', 'game_results', 'learning_files', 'login_otp_device_skips',
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
    'game_progress_save_commits', 'game_results', 'learning_files', 'login_otp_device_skips',
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
    'game_progress_save_commits', 'game_results', 'learning_files', 'login_otp_device_skips',
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

ROLLBACK;
