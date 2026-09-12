const { buildStudentAnalyticsMetrics } = require('./studentAnalyticsMetrics.utils');

// Capture canonical progress and all learning-cycle evidence in the same read
// snapshot. A reset may commit concurrently, but cannot mix new-cycle answers
// with an older quest/score snapshot, including when the new cycle has no rows.
async function loadStudentAnalyticsEvidence({ progressQuery, params = [], normalizeProgress = (row) => row }, pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const progress = await client.query(progressQuery, params);
    const evidence = await loadStudentEvidenceRows(progress.rows.map(normalizeProgress), client);
    await client.query('COMMIT');
    return evidence;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Roles scope the canonical query before this shared read. All consumers use
// complete current-cycle evidence; history pagination is separate.
async function loadStudentEvidenceRows(progressRows, queryClient) {
  const rows = Array.isArray(progressRows) ? progressRows : [];
  if (rows.length === 0) return [];
  const studentIds = [...new Set(rows.map((row) => Number(row.student_id)))];
  const results = await queryClient.query(
      `SELECT gr.resolved_student_id, gr.id, gr.math_topic, gr.difficulty, gr.current_map,
              gr.percentage, gr.score, gr.total_items, gr.played_at, gr.question_set_id
       FROM public.game_results gr
       JOIN public.accounts student ON student.id = gr.resolved_student_id
       WHERE gr.resolved_student_id = ANY($1::INTEGER[])
         AND (student.current_learning_cycle_started_at IS NULL
              OR gr.played_at >= student.current_learning_cycle_started_at)
       ORDER BY gr.played_at ASC NULLS LAST, gr.id ASC`,
      [studentIds]
    );
  const playtime = await queryClient.query(
      `SELECT ps.student_id, ps.total_playtime_minutes, ps.status, ps.date_played, ps.end_time
       FROM public.playtime_sessions ps
       JOIN public.accounts student ON student.id = ps.student_id
       WHERE ps.student_id = ANY($1::INTEGER[])
         AND COALESCE(ps.learning_cycle_version, 0) = COALESCE(student.current_learning_cycle_version, 0)
         AND (student.current_learning_cycle_started_at IS NULL
              OR COALESCE(ps.end_time, ps.start_time) >= student.current_learning_cycle_started_at)
       ORDER BY ps.date_played DESC, ps.id DESC`,
      [studentIds]
    );
  const milestones = await queryClient.query(
      `SELECT student_id, milestone_id, map_id, weight, learning_cycle_version, completed_at
       FROM public.student_quest_milestones
       WHERE student_id = ANY($1::INTEGER[])
       ORDER BY completed_at ASC, id ASC`,
      [studentIds]
    );
  const cycleByStudent = new Map(rows.map((row) => [
    Number(row.student_id),
    Number(row.current_learning_cycle_version ?? row.learning_cycle_version ?? 0),
  ]));
  const currentCycleMilestones = (milestones?.rows || []).filter((row) => (
    Number(row.learning_cycle_version ?? 0) === Number(cycleByStudent.get(Number(row.student_id)) ?? 0)
  ));
  const groupByStudent = (records, key) => {
    const grouped = new Map();
    records.forEach((row) => {
      const studentId = Number(row[key]);
      if (!grouped.has(studentId)) grouped.set(studentId, []);
      grouped.get(studentId).push(row);
    });
    return grouped;
  };
  const resultsByStudent = groupByStudent(results.rows, 'resolved_student_id');
  const playtimeByStudent = groupByStudent(playtime.rows, 'student_id');
  const milestonesByStudent = groupByStudent(currentCycleMilestones, 'student_id');
  return rows.map((progress) => {
    const quizSessions = resultsByStudent.get(Number(progress.student_id)) || [];
    const playtimeSessions = playtimeByStudent.get(Number(progress.student_id)) || [];
    const completedMilestones = milestonesByStudent.get(Number(progress.student_id)) || [];
    const metrics = buildStudentAnalyticsMetrics({ progress, quizSessions, playtimeSessions, completedMilestones });
    return { progress, quizSessions, playtimeSessions, completedMilestones, metrics };
  });
}

function withStudentAnalyticsAliases({ progress, metrics }) {
  return {
    ...progress,
    correct_answers: metrics.correctAnswers,
    incorrect_answers: metrics.incorrectAnswers,
    total_questions: metrics.totalQuestions,
    accuracy_rate: metrics.accuracy,
    performance_percentage: metrics.accuracy,
    progress_percentage: metrics.totalProgress,
    current_quest: metrics.currentQuest,
    difficulty: metrics.currentDifficulty || 'Unknown',
    difficulty_level: metrics.currentDifficulty || 'Unknown',
    difficultyBreakdown: metrics.difficultyBreakdown,
    metrics,
  };
}

module.exports = { loadStudentAnalyticsEvidence, withStudentAnalyticsAliases };
