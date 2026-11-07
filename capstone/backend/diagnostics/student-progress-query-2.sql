-- Bind $1 = authorized internal Student account ID, $2 = expected current
-- learning_cycle_version, and $3 = JSON from getPublicRegistrySnapshot().
-- Returns fixed category counts only; never return individual records or IDs.
WITH requested_scope AS (
  SELECT $1::INTEGER AS student_id, $2::INTEGER AS expected_cycle_version,
         $3::JSONB AS registry
), grade_aliases AS (
  SELECT DISTINCT
         LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(alias.value, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g')) AS alias_key,
         grade.value->>'value' AS canonical_grade
  FROM requested_scope r
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(r.registry->'grades') AS grade(value)
  CROSS JOIN LATERAL (
    SELECT grade.value->>'value' AS value
    UNION ALL
    SELECT JSONB_ARRAY_ELEMENTS_TEXT(COALESCE(grade.value->'aliases', '[]'::JSONB))
  ) AS alias
), difficulty_aliases AS (
  SELECT DISTINCT
         LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(alias.value, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g')) AS alias_key,
         difficulty.value->>'value' AS canonical_difficulty
  FROM requested_scope r
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(r.registry->'difficulties') AS difficulty(value)
  CROSS JOIN LATERAL (
    SELECT difficulty.value->>'value' AS value
    UNION ALL
    SELECT JSONB_ARRAY_ELEMENTS_TEXT(COALESCE(difficulty.value->'aliases', '[]'::JSONB))
  ) AS alias
), topic_names AS (
  SELECT DISTINCT topic.value->>'topic_id' AS topic_id,
         LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(label.value, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g')) AS label_key
  FROM requested_scope r
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(r.registry->'topics') AS topic(value)
  CROSS JOIN LATERAL (
    SELECT topic.value->>'display_label' AS value
    UNION ALL
    SELECT JSONB_ARRAY_ELEMENTS_TEXT(COALESCE(topic.value->'aliases', '[]'::JSONB))
  ) AS label
), topic_scopes AS (
  SELECT DISTINCT scope.value->>'grade_level' AS canonical_grade,
         scope.value->>'difficulty' AS canonical_difficulty,
         topic.topic_id
  FROM requested_scope r
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(r.registry->'scopes') AS scope(value)
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(scope.value->'topic_ids') AS topic(topic_id)
), student_scope AS (
  SELECT a.id AS student_id,
         COALESCE(a.current_learning_cycle_version, 0) AS current_cycle_version,
         a.current_learning_cycle_started_at
  FROM public.accounts a
  JOIN requested_scope r ON r.student_id = a.id
  WHERE LOWER(a.role) = 'student'
    AND COALESCE(a.is_archived, false) = false
), verified_scope AS (
  SELECT s.*
  FROM student_scope s
  JOIN requested_scope r ON r.expected_cycle_version >= 0
                        AND r.expected_cycle_version = s.current_cycle_version
), normalized_sets AS (
  SELECT lf.id AS question_set_id,
         lf.grade_level,
         lf.difficulty,
         lf.topic_id,
         lf.math_topic,
         REGEXP_REPLACE(COALESCE(lf.topic_id, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') AS topic_id_trimmed,
         REGEXP_REPLACE(COALESCE(lf.math_topic, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') AS math_topic_trimmed,
         grade_alias.canonical_grade,
         difficulty_alias.canonical_difficulty
  FROM public.learning_files lf
  LEFT JOIN grade_aliases grade_alias
    ON grade_alias.alias_key = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(lf.grade_level, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g'))
  LEFT JOIN difficulty_aliases difficulty_alias
    ON difficulty_alias.alias_key = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(lf.difficulty, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g'))
), resolved_sets AS (
  SELECT s.*,
         CASE WHEN s.topic_id_trimmed <> '' THEN direct_topic.topic_id
              ELSE legacy_topic.topic_id END AS resolved_set_topic_id,
         (s.topic_id_trimmed <> '' AND direct_topic.topic_id IS NULL) AS invalid_nonblank_set_topic_id
  FROM normalized_sets s
  LEFT JOIN LATERAL (
    SELECT st.topic_id
    FROM topic_scopes st
    WHERE st.canonical_grade = s.canonical_grade
      AND st.canonical_difficulty = s.canonical_difficulty
      AND st.topic_id = s.topic_id_trimmed
    LIMIT 1
  ) direct_topic ON true
  LEFT JOIN LATERAL (
    SELECT MIN(st.topic_id) AS topic_id
    FROM topic_scopes st
    JOIN topic_names tn ON tn.topic_id = st.topic_id
    WHERE st.canonical_grade = s.canonical_grade
      AND st.canonical_difficulty = s.canonical_difficulty
      AND tn.label_key = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(s.math_topic_trimmed, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g'))
    HAVING COUNT(DISTINCT st.topic_id) = 1
  ) legacy_topic ON true
), normalized_questions AS (
  SELECT q.id AS question_id,
         q.learning_file_id AS question_set_id,
         q.grade_level,
         q.difficulty,
         q.topic_id,
         q.math_topic,
         REGEXP_REPLACE(COALESCE(q.topic_id, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') AS topic_id_trimmed,
         REGEXP_REPLACE(COALESCE(q.math_topic, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') AS math_topic_trimmed,
         s.canonical_grade AS set_canonical_grade,
         s.canonical_difficulty AS set_canonical_difficulty,
         s.resolved_set_topic_id,
         s.invalid_nonblank_set_topic_id,
         CASE WHEN q.grade_level IS NULL OR q.grade_level = '' THEN s.canonical_grade
              ELSE q_grade.canonical_grade END AS effective_question_grade,
         CASE WHEN q.difficulty IS NULL OR q.difficulty = '' THEN s.canonical_difficulty
              ELSE q_difficulty.canonical_difficulty END AS effective_question_difficulty,
         CASE WHEN REGEXP_REPLACE(COALESCE(q.topic_id, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') <> ''
              THEN direct_topic.topic_id ELSE legacy_topic.topic_id END AS resolved_question_topic_id,
         direct_topic.topic_id AS resolved_question_id_topic_id,
         legacy_topic.topic_id AS resolved_question_label_topic_id,
         (REGEXP_REPLACE(COALESCE(q.topic_id, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') <> ''
          AND direct_topic.topic_id IS NULL) AS invalid_nonblank_question_topic_id,
         (REGEXP_REPLACE(COALESCE(q.math_topic, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') <> ''
          AND legacy_topic.topic_id IS NULL) AS invalid_nonblank_question_label,
         (s.canonical_grade IS NULL OR s.canonical_difficulty IS NULL
          OR CASE WHEN q.grade_level IS NULL OR q.grade_level = '' THEN s.canonical_grade
                  ELSE q_grade.canonical_grade END IS NULL
          OR CASE WHEN q.difficulty IS NULL OR q.difficulty = '' THEN s.canonical_difficulty
                  ELSE q_difficulty.canonical_difficulty END IS NULL
          OR CASE WHEN q.grade_level IS NULL OR q.grade_level = '' THEN s.canonical_grade
                  ELSE q_grade.canonical_grade END <> s.canonical_grade
          OR CASE WHEN q.difficulty IS NULL OR q.difficulty = '' THEN s.canonical_difficulty
                  ELSE q_difficulty.canonical_difficulty END <> s.canonical_difficulty) AS question_grade_difficulty_conflict
  FROM public.questions q
  JOIN resolved_sets s ON s.question_set_id = q.learning_file_id
  LEFT JOIN grade_aliases q_grade
    ON q_grade.alias_key = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(q.grade_level, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g'))
  LEFT JOIN difficulty_aliases q_difficulty
    ON q_difficulty.alias_key = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(q.difficulty, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g'))
  LEFT JOIN LATERAL (
    SELECT st.topic_id
    FROM topic_scopes st
    WHERE st.canonical_grade = s.canonical_grade
      AND st.canonical_difficulty = s.canonical_difficulty
      AND st.topic_id = REGEXP_REPLACE(COALESCE(q.topic_id, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g')
    LIMIT 1
  ) direct_topic ON true
  LEFT JOIN LATERAL (
    SELECT MIN(st.topic_id) AS topic_id
    FROM topic_scopes st
    JOIN topic_names tn ON tn.topic_id = st.topic_id
    WHERE st.canonical_grade = s.canonical_grade
      AND st.canonical_difficulty = s.canonical_difficulty
      AND tn.label_key = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(q.math_topic, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g'))
    HAVING COUNT(DISTINCT st.topic_id) = 1
  ) legacy_topic ON true
), question_set_summary AS (
  SELECT nq.question_set_id,
         COUNT(*)::BIGINT AS source_question_count,
         COUNT(DISTINCT nq.resolved_question_id_topic_id) FILTER (WHERE nq.resolved_question_id_topic_id IS NOT NULL)::INTEGER AS question_id_topic_count,
         MIN(nq.resolved_question_id_topic_id) FILTER (WHERE nq.resolved_question_id_topic_id IS NOT NULL) AS question_id_topic_id,
         COUNT(DISTINCT nq.resolved_question_label_topic_id) FILTER (WHERE nq.resolved_question_label_topic_id IS NOT NULL)::INTEGER AS question_label_topic_count,
         MIN(nq.resolved_question_label_topic_id) FILTER (WHERE nq.resolved_question_label_topic_id IS NOT NULL) AS question_label_topic_id,
         BOOL_OR(nq.invalid_nonblank_question_topic_id) AS has_invalid_question_topic_id,
         BOOL_OR(nq.invalid_nonblank_question_label) AS has_invalid_question_label,
         BOOL_OR(nq.question_grade_difficulty_conflict) AS has_question_scope_conflict
  FROM normalized_questions nq
  GROUP BY nq.question_set_id
), result_rows AS (
  SELECT gr.id,
         gr.question_id,
         gr.question_set_id,
         gr.score,
         gr.total_items,
         gr.played_at,
         gr.session_id,
         gr.playtime_session_id,
         s.current_cycle_version,
         s.current_learning_cycle_started_at,
         analytics_session.id AS analytics_session_id,
         analytics_session.learning_cycle_version AS analytics_session_cycle,
         lf.id AS source_question_set_id,
         q_any.id AS source_question_id,
         q_exact.question_id AS exact_question_id,
         q_exact.topic_id_trimmed AS exact_question_topic_id_trimmed,
         q_exact.math_topic_trimmed AS exact_question_math_topic_trimmed,
         q_exact.resolved_question_topic_id AS exact_question_topic_id,
         q_exact.invalid_nonblank_question_topic_id AS exact_question_topic_id_invalid,
         q_exact.invalid_nonblank_question_label AS exact_question_label_invalid,
         q_exact.question_grade_difficulty_conflict AS exact_question_scope_conflict,
         rs.grade_level AS set_grade_level,
         rs.difficulty AS set_difficulty,
         rs.canonical_grade AS set_canonical_grade,
         rs.canonical_difficulty AS set_canonical_difficulty,
         rs.topic_id_trimmed AS set_topic_id_trimmed,
         rs.resolved_set_topic_id,
         rs.invalid_nonblank_set_topic_id,
         result_grade.canonical_grade AS result_canonical_grade,
         result_difficulty.canonical_difficulty AS result_canonical_difficulty,
         qss.source_question_count,
         qss.question_id_topic_count,
         qss.question_id_topic_id,
         qss.question_label_topic_count,
         qss.question_label_topic_id,
         qss.has_invalid_question_topic_id,
         qss.has_invalid_question_label,
         qss.has_question_scope_conflict,
         (s.current_learning_cycle_started_at IS NULL
          OR gr.played_at >= s.current_learning_cycle_started_at) AS boundary_eligible,
         (gr.session_id IS NULL
          OR (analytics_session.id IS NOT NULL
              AND COALESCE(analytics_session.learning_cycle_version, s.current_cycle_version, 0)
                  = s.current_cycle_version)) AS analytics_session_eligible,
         (gr.score IS NOT NULL AND gr.score >= 0
          AND gr.total_items IS NOT NULL AND gr.total_items > 0
          AND gr.score <= gr.total_items) AS score_valid
  FROM public.game_results gr
  JOIN verified_scope s ON s.student_id = gr.resolved_student_id
  LEFT JOIN public.playtime_sessions analytics_session
    ON analytics_session.id = gr.session_id
   AND analytics_session.student_id = gr.resolved_student_id
  LEFT JOIN public.questions q_any ON q_any.id = gr.question_id
  LEFT JOIN normalized_questions q_exact
    ON q_exact.question_id = gr.question_id
   AND q_exact.question_set_id = gr.question_set_id
  LEFT JOIN public.learning_files lf ON lf.id = gr.question_set_id
  LEFT JOIN resolved_sets rs ON rs.question_set_id = gr.question_set_id
  LEFT JOIN question_set_summary qss ON qss.question_set_id = gr.question_set_id
  LEFT JOIN grade_aliases result_grade
    ON result_grade.alias_key = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(gr.grade_level, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g'))
  LEFT JOIN difficulty_aliases result_difficulty
    ON result_difficulty.alias_key = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(gr.difficulty, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g'))
), eligible_rows AS (
  SELECT r.*,
         r.boundary_eligible AND r.analytics_session_eligible AS analytics_eligible,
         (r.question_set_id IS NOT NULL AND r.source_question_set_id IS NOT NULL
          AND (r.result_canonical_grade IS NULL OR r.result_canonical_difficulty IS NULL
               OR r.result_canonical_grade <> r.set_canonical_grade
               OR r.result_canonical_difficulty <> r.set_canonical_difficulty)) AS result_scope_conflict,
         CASE
           WHEN r.question_id IS NOT NULL THEN
             CASE WHEN r.exact_question_id IS NULL THEN NULL
                  WHEN r.exact_question_topic_id IS NOT NULL
                       AND r.resolved_set_topic_id IS NOT NULL
                       AND r.exact_question_topic_id <> r.resolved_set_topic_id THEN NULL
                  ELSE COALESCE(r.exact_question_topic_id, r.resolved_set_topic_id) END
           ELSE
             CASE WHEN COALESCE(r.has_invalid_question_topic_id, false)
                        OR COALESCE(r.has_invalid_question_label, false)
                        OR COALESCE(r.question_id_topic_count, 0) > 1
                        OR COALESCE(r.question_label_topic_count, 0) > 1
                        OR (r.question_id_topic_id IS NOT NULL AND r.question_label_topic_id IS NOT NULL
                            AND r.question_id_topic_id <> r.question_label_topic_id)
                        OR (r.resolved_set_topic_id IS NOT NULL AND r.question_id_topic_id IS NOT NULL
                            AND r.resolved_set_topic_id <> r.question_id_topic_id)
                        OR (r.resolved_set_topic_id IS NOT NULL AND r.question_label_topic_id IS NOT NULL
                            AND r.resolved_set_topic_id <> r.question_label_topic_id)
                  THEN NULL
                  ELSE COALESCE(r.question_id_topic_id, r.question_label_topic_id, r.resolved_set_topic_id) END
         END AS analytics_topic_id,
         CASE
           WHEN r.question_id IS NOT NULL THEN
             r.exact_question_id IS NOT NULL
             AND r.exact_question_topic_id IS NOT NULL
             AND r.resolved_set_topic_id IS NOT NULL
             AND r.exact_question_topic_id <> r.resolved_set_topic_id
           ELSE
             COALESCE(r.question_id_topic_count, 0) > 1
             OR COALESCE(r.question_label_topic_count, 0) > 1
             OR (r.question_id_topic_id IS NOT NULL AND r.question_label_topic_id IS NOT NULL
                 AND r.question_id_topic_id <> r.question_label_topic_id)
             OR (r.resolved_set_topic_id IS NOT NULL AND r.question_id_topic_id IS NOT NULL
                 AND r.resolved_set_topic_id <> r.question_id_topic_id)
             OR (r.resolved_set_topic_id IS NOT NULL AND r.question_label_topic_id IS NOT NULL
                 AND r.resolved_set_topic_id <> r.question_label_topic_id)
         END AS topic_sources_conflict,
         CASE
           WHEN r.question_id IS NOT NULL THEN COALESCE(r.exact_question_scope_conflict, false)
           ELSE COALESCE(r.has_question_scope_conflict, false)
         END AS question_scope_conflict
  FROM result_rows r
  WHERE r.boundary_eligible AND r.analytics_session_eligible
)
SELECT
  (SELECT COUNT(*) FROM student_scope)::BIGINT AS selected_student_scope_match_count,
  (SELECT COUNT(*) FROM verified_scope)::BIGINT AS current_cycle_parameter_match_count,
  COUNT(*)::BIGINT AS current_cycle_eligible_result_count,
  COUNT(*) FILTER (WHERE score_valid)::BIGINT AS current_cycle_valid_score_result_count,
  COUNT(*) FILTER (WHERE score_valid AND analytics_topic_id IS NOT NULL)::BIGINT AS analytics_topic_linked_result_count,
  COUNT(*) FILTER (WHERE score_valid AND analytics_topic_id IS NOT NULL
                   AND NOT result_scope_conflict AND NOT question_scope_conflict)::BIGINT AS safe_topic_recovered_result_count,
  COUNT(*) FILTER (WHERE score_valid AND question_id IS NOT NULL AND exact_question_id IS NOT NULL
                   AND exact_question_topic_id IS NOT NULL
                   AND (resolved_set_topic_id IS NULL OR resolved_set_topic_id = exact_question_topic_id)
                   AND exact_question_topic_id_trimmed <> '')::BIGINT AS exact_question_canonical_id_recovery_count,
  COUNT(*) FILTER (WHERE score_valid AND question_id IS NOT NULL AND exact_question_id IS NOT NULL
                   AND exact_question_topic_id IS NOT NULL
                   AND exact_question_topic_id_trimmed = ''
                   AND (resolved_set_topic_id IS NULL OR resolved_set_topic_id = exact_question_topic_id))::BIGINT
    AS exact_question_label_recovery_count,
  COUNT(*) FILTER (WHERE score_valid AND question_id IS NOT NULL AND exact_question_id IS NOT NULL
                   AND exact_question_topic_id IS NULL AND resolved_set_topic_id IS NOT NULL)::BIGINT
    AS exact_question_set_topic_recovery_count,
  COUNT(*) FILTER (WHERE score_valid AND question_id IS NULL AND question_set_id IS NOT NULL
                   AND analytics_topic_id IS NOT NULL
                   AND NOT result_scope_conflict AND NOT question_scope_conflict)::BIGINT
    AS set_level_consistent_recovery_count,
  COUNT(*) FILTER (WHERE score_valid AND question_id IS NULL)::BIGINT AS missing_question_id_count,
  COUNT(*) FILTER (WHERE score_valid AND question_set_id IS NULL)::BIGINT AS missing_question_set_id_count,
  COUNT(*) FILTER (WHERE score_valid AND question_id IS NOT NULL AND source_question_id IS NULL)::BIGINT
    AS missing_source_question_count,
  COUNT(*) FILTER (WHERE score_valid AND question_id IS NOT NULL AND source_question_id IS NOT NULL
                   AND exact_question_id IS NULL)::BIGINT AS question_set_association_mismatch_count,
  COUNT(*) FILTER (WHERE score_valid AND question_set_id IS NOT NULL AND source_question_set_id IS NULL)::BIGINT
    AS missing_source_question_set_count,
  COUNT(*) FILTER (WHERE score_valid AND (
      (question_id IS NOT NULL AND exact_question_id IS NOT NULL AND exact_question_topic_id_invalid)
      OR (question_id IS NULL AND COALESCE(has_invalid_question_topic_id, false))))::BIGINT
    AS invalid_nonblank_question_topic_id_count,
  COUNT(*) FILTER (WHERE score_valid AND invalid_nonblank_set_topic_id)::BIGINT
    AS invalid_nonblank_set_topic_id_count,
  COUNT(*) FILTER (WHERE score_valid AND question_set_id IS NOT NULL AND source_question_set_id IS NOT NULL
                   AND (set_canonical_grade IS NULL OR set_canonical_difficulty IS NULL))::BIGINT
    AS invalid_question_set_grade_difficulty_scope_count,
  COUNT(*) FILTER (WHERE score_valid AND question_set_id IS NOT NULL AND source_question_set_id IS NOT NULL
                   AND (result_scope_conflict OR question_scope_conflict))::BIGINT
    AS grade_difficulty_scope_conflict_count,
  COUNT(*) FILTER (WHERE score_valid AND topic_sources_conflict)::BIGINT AS question_set_topic_conflict_count,
  COUNT(*) FILTER (WHERE score_valid AND question_id IS NULL
                   AND (COALESCE(question_id_topic_count, 0) > 1
                        OR COALESCE(question_label_topic_count, 0) > 1))::BIGINT AS mixed_set_question_topic_count,
  COUNT(*) FILTER (WHERE score_valid AND analytics_topic_id IS NULL)::BIGINT AS unrecoverable_topic_result_count
FROM eligible_rows;
