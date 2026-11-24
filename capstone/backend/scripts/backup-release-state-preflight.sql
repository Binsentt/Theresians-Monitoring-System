\set ON_ERROR_STOP on

-- Read-only release-state classifier for a logical backup/rehearsal.
-- Reads schema_migrations and PostgreSQL catalogs only; never application rows.
\if :{?expected_database}
\else
  \echo 'STOP: expected_database is required.'
  SELECT 1 / 0;
\endif
\if :{?expected_role}
\else
  \echo 'STOP: expected_role is required.'
  SELECT 1 / 0;
\endif
\if :{?expected_server_address}
\else
  \echo 'STOP: expected_server_address is required.'
  SELECT 1 / 0;
\endif
\if :{?expected_server_port}
\else
  \echo 'STOP: expected_server_port is required.'
  SELECT 1 / 0;
\endif

BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
-- Make pg_get_constraintdef output deterministic and schema-qualified.
SET LOCAL search_path = pg_catalog;

SELECT current_database() = :'expected_database'
       AND current_user = :'expected_role'
       AND session_user = current_user
       AND host(inet_server_addr()) = :'expected_server_address'
       AND inet_server_port() = :'expected_server_port'::integer
       AND current_setting('transaction_read_only') = 'on'
       AND current_setting('statement_timeout')::interval = interval '10 seconds'
       AND current_setting('lock_timeout')::interval = interval '2 seconds'
       AS backup_target_identity_ok \gset
\if :backup_target_identity_ok
  \echo BACKUP_TARGET_IDENTITY=PASS
\else
  \echo BACKUP_TARGET_IDENTITY=FAIL
  ROLLBACK;
  -- psql \quit ends a script but does not set its process exit code.
  -- ON_ERROR_STOP turns this read-only arithmetic error into status 3.
  SELECT 1 / 0;
\endif

SELECT to_regclass('public.schema_migrations') IS NOT NULL AS backup_ledger_present \gset
\if :backup_ledger_present
\else
  SELECT 'BACKUP_RELEASE_READINESS=UNVERIFIED',
         'BACKUP_METADATA_FINGERPRINT=UNAVAILABLE',
         'BACKUP_DATABASE_SIZE_BYTES=' || pg_database_size(current_database())::text;
  ROLLBACK;
  \quit 0
\endif

SELECT
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS ledger_relation
    JOIN pg_catalog.pg_namespace AS ledger_namespace ON ledger_namespace.oid = ledger_relation.relnamespace
    WHERE ledger_namespace.nspname = 'public' AND ledger_relation.relname = 'schema_migrations'
      AND ledger_relation.relkind = 'r' AND ledger_relation.relpersistence = 'p'
  )
  AND (
    SELECT COUNT(*) = 4 AND BOOL_AND(
      (attname = 'version' AND formatted_type = 'integer' AND attnotnull)
      OR (attname = 'filename' AND formatted_type = 'character varying(255)' AND attnotnull)
      OR (attname = 'checksum' AND formatted_type = 'character(64)' AND attnotnull)
      OR (attname = 'applied_at' AND formatted_type = 'timestamp with time zone' AND attnotnull)
    )
    FROM (
      SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type, a.attnotnull
      FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = 'public.schema_migrations'::regclass
        AND a.attnum > 0 AND NOT a.attisdropped
    ) AS ledger_columns
  )
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS applied_at
    JOIN pg_catalog.pg_attrdef AS default_record
      ON default_record.adrelid = applied_at.attrelid AND default_record.adnum = applied_at.attnum
    WHERE applied_at.attrelid = 'public.schema_migrations'::regclass
      AND applied_at.attname = 'applied_at'
      AND lower(regexp_replace(pg_catalog.pg_get_expr(default_record.adbin, default_record.adrelid), '[[:space:]]', '', 'g'))
          IN ('current_timestamp', 'now()')
  )
  AND (
    SELECT COUNT(*) = 1 AND BOOL_AND(
      constraint_record.conkey = ARRAY[version_column.attnum]::smallint[]
      AND NOT constraint_record.condeferrable AND NOT constraint_record.condeferred
      AND constraint_record.convalidated
    )
    FROM pg_catalog.pg_constraint AS constraint_record
    CROSS JOIN (
      SELECT attnum FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.schema_migrations'::regclass
        AND attname = 'version' AND attnum > 0 AND NOT attisdropped
    ) AS version_column
    WHERE constraint_record.conrelid = 'public.schema_migrations'::regclass
      AND constraint_record.contype = 'p'
  )
  AND (SELECT COUNT(*) = 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.schema_migrations'::regclass)
  AND (
    SELECT COUNT(*) = 1 AND BOOL_AND(
      index_record.indisunique AND index_record.indisprimary AND index_record.indimmediate
      AND index_record.indisvalid AND index_record.indisready AND index_record.indislive
      AND index_record.indnkeyatts = 1 AND index_record.indnatts = 1
      AND index_record.indpred IS NULL AND index_record.indexprs IS NULL
      AND access_method.amname = 'btree'
      AND ARRAY(
        SELECT attribute_record.attname::text
        FROM unnest(index_record.indkey) WITH ORDINALITY AS key_record(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute_record
          ON attribute_record.attrelid = index_record.indrelid AND attribute_record.attnum = key_record.attnum
        WHERE key_record.ordinality <= index_record.indnkeyatts
        ORDER BY key_record.ordinality
      ) = ARRAY['version']::text[]
    )
    FROM pg_catalog.pg_index AS index_record
    JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
    JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
    WHERE index_record.indrelid = 'public.schema_migrations'::regclass
  ) AS backup_ledger_shape_ok \gset
\if :backup_ledger_shape_ok
  \echo 'BACKUP_LEDGER_SHAPE=PASS'
\else
  \echo 'BACKUP_LEDGER_SHAPE=UNVERIFIED'
  SELECT 'BACKUP_RELEASE_READINESS=UNVERIFIED',
         'BACKUP_METADATA_FINGERPRINT=UNAVAILABLE',
         'BACKUP_DATABASE_SIZE_BYTES=' || pg_database_size(current_database())::text;
  ROLLBACK;
  \quit 0
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
), receipt_table AS (
  SELECT c.oid, c.relkind
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'game_progress_save_commits'
), receipt_partial_objects AS (
  -- Match the migration preflight's orphan-object checks. A clean ledger and
  -- absent table are insufficient when a partial migration object remains.
  SELECT NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint AS c
           WHERE c.conname IN (
             'game_progress_save_commits_pkey',
             'game_progress_save_commits_activity_event_unique',
             'game_progress_save_commits_student_id_fkey',
             'game_progress_save_commits_learning_cycle_version_check',
             'game_progress_save_commits_save_commit_id_hash_check',
             'game_progress_save_commits_payload_sha256_check',
             'game_progress_save_commits_response_status_check',
             'game_progress_save_commits_completion_consistency'
           )
         )
     AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger AS t
           WHERE t.tgname LIKE 'game_progress_save_commits%'
         )
     AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_type AS t
           JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' AND t.typname = 'game_progress_save_commits'
         ) AS objects_absent
), expected_columns(attname, type_oid, type_modifier, required_not_null, expected_default) AS (
  VALUES
    ('student_id', 'integer'::regtype::oid, -1, true, NULL::text),
    ('learning_cycle_version', 'integer'::regtype::oid, -1, true, NULL::text),
    ('save_commit_id_hash', 'text'::regtype::oid, -1, true, NULL::text),
    ('payload_sha256', 'text'::regtype::oid, -1, true, NULL::text),
    ('activity_event_key', 'text'::regtype::oid, -1, true, NULL::text),
    ('response_status', 'smallint'::regtype::oid, -1, true, '201'),
    ('response_body', 'jsonb'::regtype::oid, -1, false, NULL::text),
    ('created_at', 'timestamp with time zone'::regtype::oid, -1, true, 'CURRENT_TIMESTAMP'),
    ('completed_at', 'timestamp with time zone'::regtype::oid, -1, false, NULL::text)
), receipt_columns_ok AS (
  SELECT EXISTS (SELECT 1 FROM receipt_table WHERE relkind = 'r')
     AND (SELECT COUNT(*) = 9 FROM pg_catalog.pg_attribute AS a
          WHERE a.attrelid = (SELECT oid FROM receipt_table) AND a.attnum > 0 AND NOT a.attisdropped)
     AND NOT EXISTS (
       SELECT 1
       FROM expected_columns AS e
       LEFT JOIN pg_catalog.pg_attribute AS a
         ON a.attrelid = (SELECT oid FROM receipt_table) AND a.attname = e.attname AND NOT a.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum IS NULL OR a.atttypid <> e.type_oid OR a.atttypmod <> e.type_modifier
          OR a.attnotnull <> e.required_not_null OR a.attgenerated <> '' OR a.attidentity <> ''
          OR lower(regexp_replace(COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), '[[:space:]]', '', 'g'))
             IS DISTINCT FROM lower(COALESCE(e.expected_default, ''))
     ) AS ok
), expected_constraints(constraint_name, constraint_type, normalized_definition) AS (
  VALUES
    ('game_progress_save_commits_pkey', 'p', 'primarykey(student_id,learning_cycle_version,save_commit_id_hash)'),
    ('game_progress_save_commits_activity_event_unique', 'u', 'unique(student_id,activity_event_key)'),
    ('game_progress_save_commits_student_id_fkey', 'f', 'foreignkey(student_id)referencespublic.accounts(id)ondeletecascade'),
    ('game_progress_save_commits_learning_cycle_version_check', 'c', 'check((learning_cycle_version>=0))'),
    ('game_progress_save_commits_save_commit_id_hash_check', 'c', 'check((save_commit_id_hash~''^[0-9a-f]{64}$''::text))'),
    ('game_progress_save_commits_payload_sha256_check', 'c', 'check((payload_sha256~''^[0-9a-f]{64}$''::text))'),
    ('game_progress_save_commits_response_status_check', 'c', 'check(((response_status>=200)and(response_status<=299)))'),
    ('game_progress_save_commits_completion_consistency', 'c', 'check(((response_bodyisnull)=(completed_atisnull)))')
), receipt_constraints_ok AS (
  SELECT EXISTS (SELECT 1 FROM receipt_table WHERE relkind = 'r')
     AND (SELECT COUNT(*) = 8 FROM pg_catalog.pg_constraint AS c
          WHERE c.conrelid = (SELECT oid FROM receipt_table))
     AND NOT EXISTS (
       SELECT 1
       FROM expected_constraints AS e
       LEFT JOIN pg_catalog.pg_constraint AS c
         ON c.conrelid = (SELECT oid FROM receipt_table) AND c.conname = e.constraint_name
       WHERE c.oid IS NULL OR c.contype::text <> e.constraint_type OR NOT c.convalidated
          OR c.condeferrable OR c.condeferred
          OR lower(regexp_replace(pg_catalog.pg_get_constraintdef(c.oid, false), '[[:space:]]', '', 'g'))
             IS DISTINCT FROM e.normalized_definition
     )
     AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint AS fk
       WHERE fk.conrelid = (SELECT oid FROM receipt_table)
         AND fk.conname = 'game_progress_save_commits_student_id_fkey'
         AND fk.confrelid = to_regclass('public.accounts')
         AND fk.confdeltype = 'c' AND fk.confupdtype = 'a'
     ) AS ok
), expected_receipt_indexes(index_name, is_primary, key_columns) AS (
  VALUES
    ('game_progress_save_commits_pkey', true,
      ARRAY['student_id', 'learning_cycle_version', 'save_commit_id_hash']::text[]),
    ('game_progress_save_commits_activity_event_unique', false,
      ARRAY['student_id', 'activity_event_key']::text[])
), receipt_indexes_ok AS (
  SELECT
    (SELECT COUNT(*) = 2 FROM pg_catalog.pg_index AS i WHERE i.indrelid = (SELECT oid FROM receipt_table))
    AND NOT EXISTS (
      SELECT 1
      FROM expected_receipt_indexes AS e
      LEFT JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.relnamespace = 'public'::regnamespace
       AND index_relation.relname = e.index_name AND index_relation.relkind = 'i'
      LEFT JOIN pg_catalog.pg_index AS i
        ON i.indexrelid = index_relation.oid AND i.indrelid = (SELECT oid FROM receipt_table)
      LEFT JOIN pg_catalog.pg_am AS am ON am.oid = index_relation.relam
      WHERE i.indexrelid IS NULL OR NOT i.indisunique OR i.indisprimary <> e.is_primary
         OR NOT i.indimmediate OR NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive
         OR i.indnkeyatts <> cardinality(e.key_columns) OR i.indnatts <> cardinality(e.key_columns)
         OR i.indpred IS NOT NULL OR i.indexprs IS NOT NULL OR am.amname <> 'btree'
         OR ARRAY(
              SELECT attribute_record.attname::text
              FROM unnest(i.indkey) WITH ORDINALITY AS key_record(attnum, ordinality)
              JOIN pg_catalog.pg_attribute AS attribute_record
                ON attribute_record.attrelid = i.indrelid AND attribute_record.attnum = key_record.attnum
              WHERE key_record.ordinality <= i.indnkeyatts
              ORDER BY key_record.ordinality
            ) IS DISTINCT FROM e.key_columns
    ) AS ok
), expected_pre026_columns(table_name, column_name) AS (
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
), pre026_schema_contract AS (
  SELECT
    COUNT(DISTINCT expected.table_name) FILTER (WHERE relation.oid IS NOT NULL)::integer AS present_table_count,
    COUNT(*) FILTER (WHERE attribute.attnum IS NOT NULL)::integer AS present_column_count,
    COUNT(*) FILTER (WHERE relation.oid IS NULL)::integer AS missing_table_column_count,
    COUNT(*) FILTER (WHERE relation.oid IS NOT NULL AND attribute.attnum IS NULL)::integer AS missing_column_count
  FROM expected_pre026_columns AS expected
  LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = 'public'
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.relnamespace = namespace.oid AND relation.relname = expected.table_name
   AND relation.relkind IN ('r', 'p')
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid AND attribute.attname = expected.column_name
   AND attribute.attnum > 0 AND NOT attribute.attisdropped
), expected_pre026_types(table_name, column_name, expected_data_type) AS (
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
), pre026_type_mismatches AS (
  SELECT expected.table_name, expected.column_name
  FROM expected_pre026_types AS expected
  LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = 'public'
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.relnamespace = namespace.oid AND relation.relname = expected.table_name
   AND relation.relkind IN ('r', 'p')
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid AND attribute.attname = expected.column_name
   AND attribute.attnum > 0 AND NOT attribute.attisdropped
  LEFT JOIN pg_catalog.pg_type AS data_type ON data_type.oid = attribute.atttypid
  WHERE attribute.attname IS NULL OR data_type.oid IS NULL
     OR pg_catalog.format_type(data_type.oid, NULL) IS DISTINCT FROM expected.expected_data_type
), pre026_schema_ok AS (
  SELECT
    schema_contract.present_table_count = 17
    AND schema_contract.present_column_count = 269
    AND schema_contract.missing_table_column_count = 0
    AND schema_contract.missing_column_count = 0
    AND NOT EXISTS (SELECT 1 FROM pre026_type_mismatches)
    AND COALESCE((
      SELECT data_type.oid = 'pg_catalog.varchar'::regtype
         AND attribute.atttypmod = 12
         AND pg_catalog.format_type(data_type.oid, attribute.atttypmod) = 'character varying(8)'
      FROM pg_catalog.pg_namespace AS namespace
      JOIN pg_catalog.pg_class AS relation ON relation.relnamespace = namespace.oid
      JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
      JOIN pg_catalog.pg_type AS data_type ON data_type.oid = attribute.atttypid
      WHERE namespace.nspname = 'public' AND relation.relname = 'accounts'
        AND relation.relkind IN ('r', 'p') AND attribute.attname = 'game_student_id'
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
    ), false)
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_record
      JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = 'teacher_class_assignments'
        AND trigger_record.tgname = 'teacher_class_assignments_validate_teacher'
        AND NOT trigger_record.tgisinternal AND trigger_record.tgenabled <> 'D'
    ) AS ok
  FROM pre026_schema_contract AS schema_contract
), release_rows AS (
  SELECT m.version, m.filename, LOWER(BTRIM(m.checksum)) AS checksum
  FROM public.schema_migrations AS m
  WHERE m.version >= 18
), ledger_summary AS (
  SELECT COUNT(*)::integer AS release_row_count,
         COUNT(DISTINCT version)::integer AS distinct_release_version_count,
         COUNT(*) FILTER (WHERE version BETWEEN 18 AND 25)::integer AS through_025_count,
         COUNT(*) FILTER (WHERE version = 26)::integer AS version_026_count,
         BOOL_AND(version BETWEEN 18 AND 26) AS known_release_versions_only,
         NOT EXISTS (
           SELECT 1 FROM expected AS e
           LEFT JOIN release_rows AS r ON r.version = e.version
           WHERE r.version IS NOT NULL AND (r.filename IS DISTINCT FROM e.filename OR r.checksum IS DISTINCT FROM e.source_sha256)
         ) AS recorded_checksums_match,
         NOT EXISTS (
           SELECT 1 FROM expected AS e
           LEFT JOIN release_rows AS r ON r.version = e.version
           WHERE e.version BETWEEN 18 AND 25 AND r.version IS NULL
         ) AS versions_018_025_complete,
         NOT EXISTS (SELECT 1 FROM release_rows WHERE version > 26) AS no_migration_after_026
  FROM release_rows
), pre026_core_contract_status AS (
  SELECT bool_and(ok) AS ok FROM pre026_schema_ok), metadata_signature AS (
  -- MD5 is only a compact equality fingerprint for this catalog snapshot; it
  -- is not archive integrity, tamper evidence, or proof of application data.
  SELECT md5(COALESCE(string_agg(signature, E'\n' ORDER BY signature), '')) AS fingerprint
  FROM (
    SELECT 'ledger|' || version::text || '|' || filename || '|' || checksum AS signature
    FROM release_rows
    UNION ALL
    SELECT 'relation|' || n.nspname || '|' || c.relname || '|' || c.relkind::text
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    UNION ALL
    SELECT 'column|' || n.nspname || '|' || c.relname || '|' || a.attnum::text || '|' || a.attname || '|' || pg_catalog.format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    UNION ALL
    SELECT 'constraint|' || n.nspname || '|' || c.relname || '|' || con.conname || '|' || con.contype::text || '|' || con.convalidated::text || '|' || pg_catalog.pg_get_constraintdef(con.oid, true)
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'index|' || n.nspname || '|' || c.relname || '|' || i.relname || '|' || pg_catalog.pg_get_indexdef(i.oid)
    FROM pg_catalog.pg_index AS x
    JOIN pg_catalog.pg_class AS c ON c.oid = x.indrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_class AS i ON i.oid = x.indexrelid
    WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'trigger|' || n.nspname || '|' || c.relname || '|' || t.tgname || '|' || pg_catalog.pg_get_triggerdef(t.oid, true)
    FROM pg_catalog.pg_trigger AS t
    JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'extension|' || e.extname || '|' || e.extversion || '|' || ext_namespace.nspname
    FROM pg_catalog.pg_extension AS e
    JOIN pg_catalog.pg_namespace AS ext_namespace ON ext_namespace.oid = e.extnamespace
  ) AS signatures
)
SELECT 'BACKUP_RELEASE_READINESS=' || CASE
         WHEN ledger_summary.release_row_count = 8
          AND ledger_summary.distinct_release_version_count = 8
          AND ledger_summary.through_025_count = 8
          AND ledger_summary.version_026_count = 0
          AND ledger_summary.known_release_versions_only
          AND ledger_summary.recorded_checksums_match
          AND ledger_summary.versions_018_025_complete
          AND ledger_summary.no_migration_after_026
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_class AS c
            JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname LIKE 'game_progress_save_commits%'
          )
          AND (SELECT objects_absent FROM receipt_partial_objects)
         
           AND (SELECT ok FROM pre026_core_contract_status)
          THEN 'PRE_MIGRATION_026'
         WHEN ledger_summary.release_row_count = 9
          AND ledger_summary.distinct_release_version_count = 9
          AND ledger_summary.through_025_count = 8
          AND ledger_summary.version_026_count = 1
          AND ledger_summary.known_release_versions_only
          AND ledger_summary.recorded_checksums_match
          AND ledger_summary.versions_018_025_complete
          AND ledger_summary.no_migration_after_026
           AND (SELECT ok FROM pre026_core_contract_status)
          AND (SELECT ok FROM receipt_columns_ok)

          AND (SELECT ok FROM receipt_constraints_ok)
         
          THEN 'POST_MIGRATION_026'
         ELSE 'UNVERIFIED'
       END,
       'BACKUP_METADATA_FINGERPRINT=' || metadata_signature.fingerprint,
       'BACKUP_DATABASE_SIZE_BYTES=' || pg_database_size(current_database())::text
FROM ledger_summary CROSS JOIN metadata_signature;

ROLLBACK;
