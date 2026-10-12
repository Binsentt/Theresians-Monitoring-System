const test = require('node:test');
const assert = require('node:assert/strict');

const { loadStudentAnalyticsEvidence } = require('./studentAnalyticsEvidence.service');

test('joins committed game results to their canonical question-set Grade/topic before aggregation', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT progress')) {
        return { rows: [{ student_id: 18, current_learning_cycle_version: 2 }] };
      }
      if (normalized.startsWith('SELECT gr.')) {
        return { rows: [{
          resolved_student_id: 18,
          id: 42,
          score: 2,
          total_items: 5,
          difficulty: 'Easy',
          math_topic: 'Untrusted client label',
          question_set_id: 901,
          canonical_topic_id: 'subtraction',
          canonical_grade_level: 'Grade 1',
          canonical_difficulty: 'Easy',
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const evidence = await loadStudentAnalyticsEvidence({
    progressQuery: 'SELECT progress FROM public.student_progress',
    params: [],
  }, { connect: async () => client });

  const resultQuery = queries.find((entry) => entry.sql.startsWith('SELECT gr.'));
  assert.match(resultQuery.sql, /LEFT JOIN public\.learning_files lf ON lf\.id = gr\.question_set_id/i);
  assert.match(resultQuery.sql, /lf\.topic_id AS canonical_topic_id/i);
  assert.match(resultQuery.sql, /lf\.grade_level AS canonical_grade_level/i);
  assert.deepEqual(evidence[0].metrics.topicPerformance, [{
    topicId: 'subtraction',
    topic: 'Subtraction',
    gradeLevel: 'Grade 1',
    correctAnswers: 2,
    incorrectAnswers: 3,
    totalQuestions: 5,
    accuracy: 40,
  }]);
});
