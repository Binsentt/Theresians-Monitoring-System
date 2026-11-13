\set ON_ERROR_STOP on
-- Read-only pre-migration 026 check. Catalog and schema_migrations only; no application rows.
\if :{?expected_database}
\else
  \echo 'STOP: -v expected_database is required.'
  SELECT 'pre-026 preflight stopped: expected_database is required'::integer;
\endif
\if :{?expected_role}
\else
  \echo 'STOP: -v expected_role is required.'
  SELECT 'pre-026 preflight stopped: expected_role is required'::integer;
\endif
\if :{?expected_server_address}
\else
  \echo 'STOP: -v expected_server_address is required.'
  SELECT 'pre-026 preflight stopped: expected_server_address is required'::integer;
\endif
\if :{?expected_server_port}
\else
  \echo 'STOP: -v expected_server_port is required.'
  SELECT 'pre-026 preflight stopped: expected_server_port is required'::integer;
\endif
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SELECT current_database() = :'expected_database'
       AND current_user = :'expected_role'
       AND current_user = 'tq_release_preflight_reader'
       AND session_user = current_user
       AND host(inet_server_addr()) = :'expected_server_address'
       AND inet_server_port() = :'expected_server_port'::integer
       AND current_setting('transaction_read_only') = 'on'
       AND current_setting('statement_timeout')::interval = interval '10 seconds'
       AND current_setting('lock_timeout')::interval = interval '2 seconds' AS target_identity_ok \gset
\if :target_identity_ok
  \echo 'Target identity and read-only limits match.'
\else
  \echo 'STOP: target identity or read-only limits do not match.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: target identity mismatch'::integer;
\endif
SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ledger_present \gset
\if :ledger_present
  \echo 'Migration ledger exists.'
\else
  \echo 'STOP: schema_migrations is missing; do not infer migration state.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: migration ledger is missing'::integer;
\endif
WITH expected(version, filename, source_sha256) AS (
  VALUES
    (18, '018_website_sessions_and_audit_metadata.sql', 'f64e6e0de7abdf873fdb1bc93739d2704e4b16ed5bc428c991c7507407ea5668'),
    (19, '019_playtime_history_removal.sql', 'b76fa5f58daae29dbcf2120b4c9ff533eda3c41dc3f21efdab93b207fb8b2f4f'),
    (20, '020_add_auth_otp_challenge_security.sql', '6e2cf94b9a8acdcee728e8a0283a95580fc7e63f6622dcb5890415f4b9e715af'),
    (21, '021_canonical_milestones_and_activity_contract.sql', '3b5ff42ba45a158df434b92b95e935c608fc0a236516d8135d6d0329963beac6'),
    (22, '022_game_telemetry_contract.sql', '5a45ef2133bc0d69fe117f7164eeb9af65eb16bcf6f4a1215804bd14919e3c76'),
    (23, '023_quest_evidence_and_playtime_tombstones.sql', '2df0959d48efd554a8e7403ebbf331bfdfb6971b2d66e43a6ae267c02642f12d'),
    (24, '024_remove_legacy_six_digit_students.sql', '2595a35fe97699376b611f21cc19aa4b7e26d495463fe7585bf7e1c96370e111'),
    (25, '025_add_game_result_question_traceability.sql', '2a1b904056274c73903cfb713703c6db8e6c2ea37f9c8fd1863f9a3004e42e68'),
    (26, '026_game_progress_save_commit_idempotency.sql', '334f7b73ddc1c8d6ddcdafd547181f75fbeac85df713d4ba73995fb9c4d23b12')
), applied AS (
  SELECT e.version, e.filename, e.source_sha256, m.version AS applied_version,
         m.filename AS applied_filename, LOWER(BTRIM(COALESCE(m.checksum, ''))) AS applied_sha256
  FROM expected e LEFT JOIN public.schema_migrations m ON m.version=e.version
)
SELECT NOT EXISTS (SELECT 1 FROM applied WHERE applied_version IS NOT NULL AND (applied_filename IS DISTINCT FROM filename OR applied_sha256 IS DISTINCT FROM source_sha256)) AS checksums_ok,
       NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version > 26) AS no_newer_versions,
       NOT EXISTS (SELECT 1 FROM public.schema_migrations m WHERE m.version >= 18 AND NOT EXISTS (SELECT 1 FROM expected e WHERE e.version=m.version)) AS no_unknown_release_versions,
       (SELECT COUNT(*)=8 FROM applied WHERE version BETWEEN 18 AND 25 AND applied_version IS NOT NULL) AS versions_018_025_complete,
       NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version=24) AS migration_024_is_pending,
       NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version=25) AS migration_025_is_pending,
       NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version=26) AS migration_026_is_pending \gset
\if :checksums_ok
  \echo 'Applied migration filenames and checksums match current source.'
\else
  \echo 'STOP: migration filename/checksum mismatch.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: migration checksum mismatch'::integer;
\endif
\if :no_newer_versions
\else
  \echo 'STOP: a newer migration is recorded.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: newer migration is recorded'::integer;
\endif
\if :no_unknown_release_versions
\else
  \echo 'STOP: an unknown release migration is recorded.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: unknown release migration is recorded'::integer;
\endif
\if :migration_024_is_pending
  \echo 'STOP: destructive migration 024 is pending; separate impact review and approval are required.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: migration 024 is pending'::integer;
\else
  \echo 'Migration 024 is recorded with a matching source checksum.'
\endif
\if :migration_025_is_pending
  \echo 'STOP: migration 025 is pending.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: migration 025 is pending'::integer;
\else
  \echo 'Migration 025 is recorded with a matching source checksum.'
\endif
\if :versions_018_025_complete
\else
  \echo 'STOP: migrations 018–025 are not all applied.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: migrations 018 through 025 are incomplete'::integer;
\endif
\if :migration_026_is_pending
  \echo 'Migration 026 is the expected pending migration.'
\else
  \echo 'STOP: migration 026 is already recorded; use the post-migration preflight.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: migration 026 is not pending'::integer;
\endif
SELECT to_regclass('public.game_progress_save_commits') IS NULL
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'game_progress_save_commits%')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conname IN ('game_progress_save_commits_pkey','game_progress_save_commits_activity_event_unique','game_progress_save_commits_student_id_fkey','game_progress_save_commits_learning_cycle_version_check','game_progress_save_commits_save_commit_id_hash_check','game_progress_save_commits_payload_sha256_check','game_progress_save_commits_response_status_check','game_progress_save_commits_completion_consistency'))
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE 'game_progress_save_commits%')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='game_progress_save_commits') AS receipt_objects_absent \gset
\if :receipt_objects_absent
  \echo 'No migration-026 receipt object or named partial object exists.'
\else
  \echo 'STOP: receipt objects are present or partial; do not use CREATE TABLE IF NOT EXISTS.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: partial or incompatible migration 026 objects exist'::integer;
\endif
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
  SELECT required.table_name, required.column_name, relation.oid AS relation_oid, attribute.attnum
  FROM required_columns required
  LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.nspname='public'
  LEFT JOIN pg_catalog.pg_class relation ON relation.relnamespace=namespace.oid AND relation.relname=required.table_name AND relation.relkind IN ('r','p')
  LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid=relation.oid AND attribute.attname=required.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
)
SELECT (SELECT COUNT(DISTINCT table_name) FROM schema_contract WHERE relation_oid IS NOT NULL)::integer AS present_required_table_count,
       (SELECT COUNT(*) FROM schema_contract WHERE attnum IS NOT NULL)::integer AS present_required_column_count,
       (SELECT COUNT(DISTINCT table_name) FROM schema_contract WHERE relation_oid IS NULL)::integer AS missing_table_count,
       (SELECT COUNT(*) FROM schema_contract WHERE relation_oid IS NOT NULL AND attnum IS NULL)::integer AS missing_column_count \gset
\echo 'Pre-026 schema counts: present_tables=:present_required_table_count present_columns=:present_required_column_count missing_tables=:missing_table_count missing_columns=:missing_column_count'
SELECT (:present_required_table_count::integer=17 AND :present_required_column_count::integer=269 AND :missing_table_count::integer=0 AND :missing_column_count::integer=0) AS base_schema_ok \gset
\if :base_schema_ok
  \echo 'Pre-migration startup contract is 17 tables and 269 columns.'
\else
  \echo 'STOP: pre-migration schema does not match the 17-table/269-column baseline.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: base schema contract mismatch'::integer;
\endif
WITH expected_types(table_name, column_name, expected_data_type) AS (
  VALUES
    ('accounts','id','integer'),('accounts','game_student_id','character varying'),
    ('accounts','current_learning_cycle_version','integer'),('accounts','session_version','integer'),
    ('activity_logs','id','integer'),('activity_logs','student_id','integer'),
    ('activity_logs','activity_timestamp','timestamp with time zone'),
    ('game_results','id','integer'),('game_results','resolved_student_id','integer'),
    ('game_results','response_time_seconds','integer'),
    ('student_game_progress','id','integer'),('student_game_progress','student_id','integer'),
    ('student_ai_insights','id','integer'),('student_ai_insights','student_id','integer'),('student_ai_insights','insight','jsonb'),
    ('learning_files','id','integer'),('learning_files','source_file_bytes','bytea'),
    ('playtime_sessions','id','integer'),('playtime_sessions','learning_cycle_version','integer'),
    ('playtime_sessions','deleted_at','timestamp with time zone'),('playtime_sessions','deleted_by','integer'),
    ('playtime_sessions','deletion_operation_id','uuid'),('playtime_sessions','deletion_reason','character varying')
), type_mismatches AS (
  SELECT e.table_name,e.column_name,e.expected_data_type,pg_catalog.format_type(t.oid,NULL) AS actual_data_type
  FROM expected_types e
  LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
  LEFT JOIN pg_catalog.pg_class r ON r.relnamespace=n.oid AND r.relname=e.table_name AND r.relkind IN ('r','p','v','m','f')
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attname=e.column_name AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
  WHERE a.attname IS NULL OR t.oid IS NULL OR pg_catalog.format_type(t.oid,NULL) IS DISTINCT FROM e.expected_data_type
)
SELECT NOT EXISTS (SELECT 1 FROM type_mismatches) AS core_types_ok \gset
\if :core_types_ok
  \echo 'Pre-026 core types match the current release contract.'
\else
  \echo 'STOP: pre-026 core column type mismatch.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: core type mismatch'::integer;
\endif
SELECT COALESCE((SELECT t.oid='pg_catalog.varchar'::regtype AND a.atttypmod=12 AND pg_catalog.format_type(t.oid,a.atttypmod)='character varying(8)'
  FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class r ON r.relnamespace=n.oid JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
  JOIN pg_catalog.pg_type t ON t.oid=a.atttypid WHERE n.nspname='public' AND r.relname='accounts' AND r.relkind IN ('r','p') AND a.attname='game_student_id' AND a.attnum>0 AND NOT a.attisdropped),false) AS game_student_id_width_ok \gset
\if :game_student_id_width_ok
  \echo 'accounts.game_student_id is VARCHAR(8).'
\else
  \echo 'STOP: accounts.game_student_id must be VARCHAR(8).'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: game_student_id width mismatch'::integer;
\endif
SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class r ON r.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND r.relname='teacher_class_assignments' AND t.tgname='teacher_class_assignments_validate_teacher' AND NOT t.tgisinternal AND t.tgenabled<>'D') AS teacher_trigger_ok \gset
\if :teacher_trigger_ok
  \echo 'Required teacher assignment trigger is enabled.'
\else
  \echo 'STOP: required teacher assignment trigger is missing or disabled.'
  ROLLBACK;
  SELECT 'pre-026 preflight stopped: teacher trigger missing or disabled'::integer;
\endif
WITH required_tables(table_name) AS (
  VALUES
    ('accounts'),
    ('activity_logs'),
    ('admin_audit_logs'),
    ('announcements'),
    ('folders'),
    ('game_results'),
    ('learning_files'),
    ('login_otp_device_skips'),
    ('playtime_deletion_tombstones'),
    ('playtime_sessions'),
    ('questions'),
    ('student_ai_insights'),
    ('student_game_progress'),
    ('student_quest_milestones'),
    ('teacher_class_assignments'),
    ('teacher_student_relationships'),
    ('website_sessions')
)
SELECT relation.relname, c.conname, c.contype, c.convalidated, pg_catalog.pg_get_constraintdef(c.oid)
FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class relation ON relation.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=relation.relnamespace
WHERE n.nspname='public' AND relation.relname IN (SELECT table_name FROM required_tables) ORDER BY relation.relname,c.conname;
WITH required_tables(table_name) AS (
  VALUES
    ('accounts'),
    ('activity_logs'),
    ('admin_audit_logs'),
    ('announcements'),
    ('folders'),
    ('game_results'),
    ('learning_files'),
    ('login_otp_device_skips'),
    ('playtime_deletion_tombstones'),
    ('playtime_sessions'),
    ('questions'),
    ('student_ai_insights'),
    ('student_game_progress'),
    ('student_quest_milestones'),
    ('teacher_class_assignments'),
    ('teacher_student_relationships'),
    ('website_sessions')
)
SELECT schemaname,tablename,indexname,indexdef FROM pg_catalog.pg_indexes WHERE schemaname='public' AND tablename IN (SELECT table_name FROM required_tables) ORDER BY tablename,indexname;
ROLLBACK;
\echo 'PASS: pre-026 metadata prerequisites verified; no migration or application data query was executed.'
