-- Bind $1 = authorized internal Student account ID; $2 = expected current
-- learning_cycle_version. Returns one row of fixed aggregate counts only.
WITH requested_scope AS (
  SELECT $1::INTEGER AS student_id, $2::INTEGER AS expected_cycle_version
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
), result_rows AS (
  SELECT gr.id,
         gr.question_id,
         gr.question_set_id,
         gr.session_id,
         gr.playtime_session_id,
         gr.score,
         gr.total_items,
         gr.played_at,
         s.current_cycle_version,
         s.current_learning_cycle_started_at,
         analytics_session.id AS analytics_session_id,
         analytics_session.learning_cycle_version AS analytics_session_cycle,
         parent_session.id AS parent_linked_session_id,
         parent_session.learning_cycle_version AS parent_linked_session_cycle,
         q_any.id AS source_question_id,
         q_exact.id AS exact_question_id,
         lf.id AS source_question_set_id
  FROM public.game_results gr
  JOIN verified_scope s ON s.student_id = gr.resolved_student_id
  LEFT JOIN public.playtime_sessions analytics_session
    ON analytics_session.id = gr.session_id
   AND analytics_session.student_id = gr.resolved_student_id
  LEFT JOIN public.playtime_sessions parent_session
    ON parent_session.id = COALESCE(gr.session_id, gr.playtime_session_id)
   AND parent_session.student_id = gr.resolved_student_id
  LEFT JOIN public.questions q_any
    ON q_any.id = gr.question_id
  LEFT JOIN public.questions q_exact
    ON q_exact.id = gr.question_id
   AND q_exact.learning_file_id = gr.question_set_id
  LEFT JOIN public.learning_files lf
    ON lf.id = gr.question_set_id
), flags AS (
  SELECT r.*,
         (r.current_learning_cycle_started_at IS NULL
          OR r.played_at >= r.current_learning_cycle_started_at) AS boundary_eligible,
         (r.session_id IS NULL
          OR (r.analytics_session_id IS NOT NULL
              AND COALESCE(r.analytics_session_cycle, r.current_cycle_version, 0)
                  = r.current_cycle_version)) AS analytics_session_eligible,
         CASE
           WHEN r.session_id IS NULL AND r.playtime_session_id IS NULL THEN
             r.current_cycle_version = 0
             AND r.current_learning_cycle_started_at IS NULL
           WHEN r.parent_linked_session_id IS NULL THEN false
           ELSE r.parent_linked_session_cycle IS NOT NULL
             AND r.parent_linked_session_cycle = r.current_cycle_version
             AND (r.session_id IS NULL OR r.session_id = r.parent_linked_session_id)
             AND (r.playtime_session_id IS NULL OR r.playtime_session_id = r.parent_linked_session_id)
         END AS parent_session_eligible,
         (r.score IS NOT NULL AND r.score >= 0
          AND r.total_items IS NOT NULL AND r.total_items > 0
          AND r.score <= r.total_items) AS score_valid
  FROM result_rows r
), classified AS (
  SELECT f.*,
         f.boundary_eligible AND f.analytics_session_eligible AS analytics_eligible,
         f.boundary_eligible AND f.parent_session_eligible AS parent_eligible
  FROM flags f
)
SELECT
  (SELECT COUNT(*) FROM student_scope)::BIGINT AS selected_student_scope_match_count,
  (SELECT COUNT(*) FROM verified_scope)::BIGINT AS current_cycle_parameter_match_count,
  COUNT(*) FILTER (WHERE analytics_eligible)::BIGINT AS current_cycle_eligible_result_count,
  COUNT(*) FILTER (WHERE analytics_eligible AND score_valid)::BIGINT AS current_cycle_valid_score_count,
  COALESCE(SUM(score) FILTER (WHERE analytics_eligible AND score_valid), 0)::BIGINT AS correct_answers_count,
  COALESCE(SUM(total_items - score) FILTER (WHERE analytics_eligible AND score_valid), 0)::BIGINT AS incorrect_answers_count,
  COUNT(*) FILTER (WHERE analytics_eligible AND score_valid AND question_id IS NULL)::BIGINT AS missing_question_id_count,
  COUNT(*) FILTER (WHERE analytics_eligible AND score_valid AND question_set_id IS NULL)::BIGINT AS missing_question_set_id_count,
  COUNT(*) FILTER (WHERE analytics_eligible AND score_valid AND question_id IS NOT NULL AND source_question_id IS NULL)::BIGINT AS missing_source_question_count,
  COUNT(*) FILTER (WHERE analytics_eligible AND score_valid AND question_set_id IS NOT NULL AND source_question_set_id IS NULL)::BIGINT AS missing_source_question_set_count,
  COUNT(*) FILTER (WHERE analytics_eligible AND score_valid AND question_id IS NOT NULL
                   AND question_set_id IS NOT NULL AND source_question_id IS NOT NULL AND exact_question_id IS NULL)::BIGINT
    AS question_set_association_mismatch_count,
  COUNT(*) FILTER (WHERE analytics_eligible AND score_valid AND question_id IS NOT NULL
                   AND question_set_id IS NOT NULL AND exact_question_id IS NOT NULL)::BIGINT
    AS valid_question_set_association_count,
  COUNT(*) FILTER (WHERE boundary_eligible AND session_id IS NOT NULL
                   AND playtime_session_id IS NOT NULL AND session_id <> playtime_session_id)::BIGINT
    AS session_id_mismatch_count,
  COUNT(*) FILTER (WHERE current_learning_cycle_started_at IS NOT NULL
                   AND played_at < current_learning_cycle_started_at)::BIGINT
    AS learning_cycle_timestamp_mismatch_count,
  COUNT(*) FILTER (WHERE boundary_eligible AND session_id IS NOT NULL
                   AND NOT analytics_session_eligible)::BIGINT
    AS learning_cycle_session_mismatch_count,
  COUNT(*) FILTER (WHERE parent_eligible AND score_valid)::BIGINT AS parent_history_eligible_result_count,
  COUNT(*) FILTER (WHERE parent_eligible AND score_valid AND NOT analytics_eligible)::BIGINT AS parent_only_eligible_result_count,
  COUNT(*) FILTER (WHERE analytics_eligible AND score_valid AND NOT parent_eligible)::BIGINT AS student_analytics_only_eligible_result_count
FROM classified;
