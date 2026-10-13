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

test('recovers a missing question-set topic ID only from that linked file canonical Grade and topic label', async () => {
  const row = {
    resolved_student_id: 18,
    id: 43,
    score: 2,
    total_items: 5,
    difficulty: 'Easy',
    math_topic: 'Untrusted client label',
    question_set_id: 902,
    canonical_topic_id: null,
    canonical_grade_level: 'Grade 1',
    canonical_difficulty: 'Easy',
    canonical_math_topic: 'Subtraction',
    question_topic_ids: [],
    question_math_topics: [],
  };
  const queries = [];
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      queries.push(normalized);
      if (normalized.startsWith('SELECT progress')) return { rows: [{ student_id: 18, current_learning_cycle_version: 2 }] };
      if (normalized.startsWith('SELECT gr.')) return { rows: [row] };
      return { rows: [] };
    },
    release() {},
  };
  const evidence = await loadStudentAnalyticsEvidence({
    progressQuery: 'SELECT progress FROM public.student_progress',
  }, { connect: async () => client });

  assert.match(queries.find((sql) => sql.startsWith('SELECT gr.')), /LEFT JOIN LATERAL[\s\S]*public\.questions/i);
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

test('recovers topic from unanimous canonical per-question metadata in a linked question set', async () => {
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT progress')) return { rows: [{ student_id: 18, current_learning_cycle_version: 2 }] };
      if (normalized.startsWith('SELECT gr.')) return { rows: [{
        resolved_student_id: 18,
        id: 44,
        score: 3,
        total_items: 5,
        difficulty: 'Normal',
        math_topic: 'Untrusted client label',
        question_set_id: 903,
        canonical_topic_id: null,
        canonical_grade_level: 'Grade 1',
        canonical_difficulty: 'Normal',
        canonical_math_topic: null,
        question_topic_ids: ['addition'],
        question_math_topics: [],
      }] };
      return { rows: [] };
    },
    release() {},
  };
  const evidence = await loadStudentAnalyticsEvidence({
    progressQuery: 'SELECT progress FROM public.student_progress',
  }, { connect: async () => client });

  assert.equal(evidence[0].metrics.topicPerformance[0].topic, 'Addition');
  assert.equal(evidence[0].metrics.topicPerformance[0].gradeLevel, 'Grade 1');
  assert.equal(evidence[0].metrics.topicPerformance[0].accuracy, 60);
});

test('does not infer a topic from client text when result has no question-set linkage', async () => {
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT progress')) return { rows: [{ student_id: 18, current_learning_cycle_version: 2 }] };
      if (normalized.startsWith('SELECT gr.')) return { rows: [{
        resolved_student_id: 18,
        id: 45,
        score: 0,
        total_items: 5,
        difficulty: 'Easy',
        math_topic: 'Addition',
        question_set_id: null,
        canonical_topic_id: null,
        canonical_grade_level: null,
        canonical_difficulty: null,
        canonical_math_topic: null,
        question_topic_ids: [],
        question_math_topics: [],
      }] };
      return { rows: [] };
    },
    release() {},
  };
  const evidence = await loadStudentAnalyticsEvidence({
    progressQuery: 'SELECT progress FROM public.student_progress',
  }, { connect: async () => client });

  assert.deepEqual(evidence[0].metrics.topicPerformance, []);
  assert.equal(evidence[0].metrics.topicEvidenceStatus, 'topic_metadata_unavailable');
  assert.equal(evidence[0].metrics.unmappedTopicIncorrectAnswers, 5);
});

test('does not assign an aggregate result to one topic when linked question metadata is mixed', async () => {
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT progress')) return { rows: [{ student_id: 18, current_learning_cycle_version: 2 }] };
      if (normalized.startsWith('SELECT gr.')) return { rows: [{
        resolved_student_id: 18,
        id: 46,
        score: 2,
        total_items: 5,
        difficulty: 'Normal',
        math_topic: 'Addition',
        question_set_id: 904,
        canonical_topic_id: null,
        canonical_grade_level: 'Grade 1',
        canonical_difficulty: 'Normal',
        canonical_math_topic: null,
        question_topic_ids: ['addition', 'multiplication'],
        question_math_topics: [],
      }] };
      return { rows: [] };
    },
    release() {},
  };
  const evidence = await loadStudentAnalyticsEvidence({
    progressQuery: 'SELECT progress FROM public.student_progress',
  }, { connect: async () => client });

  assert.deepEqual(evidence[0].metrics.topicPerformance, []);
  assert.equal(evidence[0].metrics.topicEvidenceStatus, 'topic_metadata_unavailable');
});
