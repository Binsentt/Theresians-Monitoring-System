'use strict';

const REQUIRED_SCHEMA = Object.freeze({
  accounts: Object.freeze(['address', 'birthday', 'created_at', 'current_learning_cycle_started_at', 'current_learning_cycle_version', 'email', 'employee_id', 'first_name', 'game_student_id', 'gender', 'grade_level', 'id', 'is_archived', 'last_name', 'middle_initial', 'mobile_number', 'must_change_password', 'name', 'otp_code', 'otp_expires_at', 'parent_id', 'password', 'progress_archive_reason', 'progress_archived_at', 'progress_archived_by', 'role', 'screen_time_reset_at', 'section', 'session_version', 'status', 'temporary_password_expires_at', 'temporary_password_issued_at']),
  activity_logs: Object.freeze(['activity_description', 'activity_event_id', 'activity_timestamp', 'actor_account_id', 'canonical_activity_id', 'canonical_milestone_id', 'canonical_quest_id', 'canonical_task_id', 'completed_at', 'created_at', 'current_map', 'current_quest', 'current_scene', 'difficulty_level', 'duration_seconds', 'grade_level', 'id', 'is_player_facing', 'last_played', 'lesson_progress', 'login_time', 'logout_time', 'map_id', 'quest_graph_version', 'quest_progress', 'role', 'save_status', 'section', 'session_date', 'session_id', 'started_at', 'status', 'student_id', 'student_name', 'telemetry_contract_version', 'total_play_time']),
  admin_audit_logs: Object.freeze(['action', 'admin_account_id', 'admin_name', 'after_metadata', 'before_metadata', 'created_at', 'id', 'operation_type', 'reason', 'target_account_id', 'target_user']),
  announcements: Object.freeze(['created_at', 'created_by', 'created_by_role', 'id', 'message', 'target_role', 'title']),
  folders: Object.freeze(['created_at', 'deleted_at', 'id', 'name', 'trashed_at']),
  game_results: Object.freeze(['answer_submitted_at', 'canonical_battle_id', 'canonical_milestone_id', 'canonical_quest_id', 'canonical_task_id', 'current_map', 'difficulty', 'grade_level', 'id', 'is_unlinked', 'map_id', 'math_topic', 'parent_id', 'percentage', 'played_at', 'playtime_session_id', 'quest_graph_version', 'question_id', 'question_presented_at', 'question_set_id', 'resolved_student_id', 'response_time_seconds', 'result_event_id', 'score', 'session_id', 'student_name', 'telemetry_contract_version', 'total_items']),
  learning_files: Object.freeze(['content_role', 'deleted_at', 'difficulty', 'document_topic', 'file_name', 'file_size', 'file_type', 'file_url', 'folder_id', 'generated_at', 'generation_completed_count', 'generation_error_code', 'generation_failed_at', 'generation_failed_batch_index', 'generation_remaining_count', 'generation_retry_count', 'generation_stage', 'generation_status', 'grade_level', 'id', 'last_fetched_at', 'math_topic', 'publish_status', 'published', 'published_at', 'published_by', 'requested_question_count', 'source', 'source_content_fingerprint', 'source_file_bytes', 'source_file_mime_type', 'source_learning_file_id', 'subject', 'title', 'topic_id', 'trashed_at', 'uploaded_at', 'uploaded_by']),
  login_otp_device_skips: Object.freeze(['created_at', 'device_id', 'id', 'otp_skipped_until', 'updated_at', 'user_id']),
  playtime_deletion_tombstones: Object.freeze(['deleted_at', 'deleted_by', 'deleted_record_id', 'deletion_operation_id', 'deletion_reason', 'id', 'target_fingerprint']),
  playtime_sessions: Object.freeze(['created_at', 'date_played', 'end_time', 'expires_at', 'grade_level', 'id', 'last_heartbeat_at', 'learning_cycle_version', 'parent_id', 'section', 'server_started_at', 'session_credential_hash', 'start_time', 'status', 'student_id', 'student_name', 'total_playtime_minutes', 'total_playtime_seconds', 'updated_at']),
  questions: Object.freeze(['correct_answer', 'created_at', 'difficulty', 'grade_level', 'id', 'learning_file_id', 'math_topic', 'options', 'published', 'question', 'source', 'topic_id', 'updated_at']),
  student_ai_insights: Object.freeze(['generated_at', 'generated_by', 'id', 'input_fingerprint', 'insight', 'stale_at', 'student_id', 'updated_at']),
  student_game_progress: Object.freeze(['accuracy_rate', 'correct_answers', 'created_at', 'current_map', 'current_quest', 'current_scene', 'difficulty_level', 'grade_level', 'id', 'last_played', 'lesson_progress', 'progress_percentage', 'score', 'section', 'student_id', 'student_name', 'total_play_time', 'total_questions', 'total_quests_completed', 'updated_at']),
  student_quest_milestones: Object.freeze(['canonical_milestone_id', 'canonical_quest_id', 'canonical_task_id', 'completed_at', 'id', 'learning_cycle_version', 'map_id', 'milestone_id', 'player_facing', 'quest_graph_version', 'source_activity_event_id', 'student_id', 'telemetry_contract_version', 'weight']),
  teacher_class_assignments: Object.freeze(['created_at', 'created_by_admin', 'grade_level', 'id', 'section', 'section_key', 'teacher_account_id', 'updated_at']),
  teacher_student_relationships: Object.freeze(['created_at', 'id', 'relationship_type', 'student_id', 'teacher_id']),
  website_sessions: Object.freeze(['account_id', 'created_at', 'credential_hash', 'expires_at', 'id', 'last_seen_at', 'revocation_reason', 'revoked_at']),
});

const SCHEMA_READINESS_SQL = `
  WITH required_columns AS (
    SELECT table_spec.table_name, column_spec.column_name
    FROM jsonb_to_recordset($1::jsonb) AS table_spec(table_name text, columns jsonb)
    CROSS JOIN LATERAL jsonb_array_elements_text(table_spec.columns) AS column_spec(column_name)
  )
  SELECT DISTINCT
    CASE
      WHEN relation.oid IS NULL THEN required_columns.table_name
      ELSE required_columns.table_name || '.' || required_columns.column_name
    END AS missing_object
  FROM required_columns
  LEFT JOIN pg_catalog.pg_namespace AS schema_namespace
    ON schema_namespace.nspname = 'public'
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.relnamespace = schema_namespace.oid
   AND relation.relname = required_columns.table_name
   AND relation.relkind IN ('r', 'p')
  LEFT JOIN pg_catalog.pg_attribute AS column_definition
    ON column_definition.attrelid = relation.oid
   AND column_definition.attname = required_columns.column_name
   AND column_definition.attnum > 0
   AND column_definition.attisdropped = false
  WHERE relation.oid IS NULL OR column_definition.attnum IS NULL
  ORDER BY missing_object
`;

async function assertStartupSchemaReady(queryClient) {
  if (!queryClient || typeof queryClient.query !== 'function') {
    throw new TypeError('a PostgreSQL query client is required for the startup schema check');
  }

  let result;
  try {
    result = await queryClient.query(SCHEMA_READINESS_SQL, [JSON.stringify(
      Object.entries(REQUIRED_SCHEMA).map(([table_name, columns]) => ({ table_name, columns })),
    )]);
  } catch (_error) {
    throw new Error('read-only database schema compatibility check failed');
  }

  const missing = [...new Set((result?.rows ?? []).map((row) => String(row.missing_object || '')).filter(Boolean))];
  if (missing.length > 0) {
    const visible = missing.slice(0, 30).join(', ');
    const remaining = missing.length - Math.min(missing.length, 30);
    throw new Error(
      `database schema is not ready: ${visible}${remaining > 0 ? `, and ${remaining} more` : ''}; `
      + 'apply separately approved schema migrations, then restart the service',
    );
  }

  return { ready: true };
}

module.exports = { REQUIRED_SCHEMA, SCHEMA_READINESS_SQL, assertStartupSchemaReady };
