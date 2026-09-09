const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveStudentAiInsight } = require('./studentAiInsight.service');

const empty = { rows: [] };
const compact = (sql) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

const createHarness = () => {
  let saved = null;
  let generatedAt = 0;
  const calls = [];
  const query = async (rawSql, params = []) => {
    const sql = compact(rawSql);
    calls.push({ sql, params });
    if (sql.includes('from public.student_ai_insights')) return { rows: saved ? [structuredClone(saved)] : [] };
    if (sql.includes('insert into public.student_ai_insights')) {
      generatedAt += 1;
      saved = {
        input_fingerprint: params[1],
        insight: JSON.parse(params[2]),
        generated_at: `2026-09-09T00:00:0${generatedAt}.000Z`,
        stale_at: null,
      };
      return { rows: [{ insight: structuredClone(saved.insight), generated_at: saved.generated_at }] };
    }
    return empty;
  };
  return {
    pool: {
      query,
      connect: async () => ({ query, release() {} }),
    },
    calls,
    getSaved: () => structuredClone(saved),
    setSaved: (value) => { saved = structuredClone(value); },
  };
};

const metricsFor = (answers) => {
  const correct = answers.filter(Boolean).length;
  return {
    validResultCount: answers.length,
    correctAnswers: correct,
    incorrectAnswers: answers.length - correct,
    totalQuestions: answers.length,
    accuracy: answers.length ? Number(((correct / answers.length) * 100).toFixed(2)) : null,
    gameScore: correct,
    totalProgress: null,
    totalProgressVerified: false,
    totalProgressSource: 'unavailable',
    completedQuests: 0,
    currentQuest: 'first-bandit-math-challenge',
    currentDifficulty: 'Easy',
    difficultyBreakdown: {
      easy: { accuracy: answers.length ? Number(((correct / answers.length) * 100).toFixed(2)) : null },
      medium: { accuracy: null },
      hard: { accuracy: null },
    },
    topicPerformance: [],
    playtimeMinutes: 0,
  };
};

const generatedInsight = (label) => ({
  performance_insight: label,
  strengths: [],
  weaknesses: [],
  recommendations: ['Continue practice from the recorded evidence.'],
});

test('zero valid results returns no-data without calling the provider or writing a cache row', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([]),
    actorId: 1,
    pool: harness.pool,
    generateInsight: async () => { providerCalls += 1; return generatedInsight('unused'); },
  });

  assert.equal(state.status, 'no_data');
  assert.equal(state.data_level, 'no_data');
  assert.equal(state.valid_result_count, 0);
  assert.equal(providerCalls, 0);
  assert.equal(harness.getSaved(), null);
});

test('four Grade 1 Oakleaf Easy results generate a real preliminary 75 percent insight', async () => {
  const harness = createHarness();
  let providerInput = null;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([1, 1, 1, 0]),
    actorId: 1,
    pool: harness.pool,
    generateInsight: async ({ input }) => {
      providerInput = input;
      return generatedInsight('Recorded overall accuracy is 75%.');
    },
  });

  assert.equal(state.status, 'generated');
  assert.equal(state.data_level, 'limited_data');
  assert.equal(state.preliminary, true);
  assert.equal(providerInput.grade, 'Grade 1');
  assert.equal(providerInput.results_recorded, 4);
  assert.equal(providerInput.accuracy, 75);
  assert.equal(providerInput.current_difficulty, 'Easy');
  assert.equal(state.insight.performance_insight, 'Recorded overall accuracy is 75%.');
});

test('Admin, Teacher, and Parent reads share one generated insight for unchanged evidence', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const args = {
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([1, 1, 1, 0]),
    pool: harness.pool,
    generateInsight: async () => {
      providerCalls += 1;
      return generatedInsight('One canonical generated insight.');
    },
  };

  const admin = await resolveStudentAiInsight({ ...args, actorId: 1 });
  const teacher = await resolveStudentAiInsight({ ...args, actorId: 2 });
  const parent = await resolveStudentAiInsight({ ...args, actorId: 3 });

  assert.equal(admin.status, 'generated');
  assert.equal(teacher.status, 'cached');
  assert.equal(parent.status, 'cached');
  assert.equal(providerCalls, 1);
  assert.deepEqual(parent.insight, admin.insight);
  assert.equal(harness.calls.filter(({ sql }) => sql === 'select pg_advisory_xact_lock($1)').length, 1);
});

test('changed evidence regenerates once and subsequent role reads use the refreshed fingerprint', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const generateInsight = async ({ input }) => {
    providerCalls += 1;
    return generatedInsight(`Accuracy ${input.accuracy}%.`);
  };
  const base = { studentId: 44, gradeLevel: 'Grade 1', pool: harness.pool, generateInsight };

  await resolveStudentAiInsight({ ...base, actorId: 1, metrics: metricsFor([1, 1, 1, 0]) });
  const refreshed = await resolveStudentAiInsight({ ...base, actorId: 2, metrics: metricsFor([1, 1, 1, 1, 0]) });
  const reused = await resolveStudentAiInsight({ ...base, actorId: 3, metrics: metricsFor([1, 1, 1, 1, 0]) });

  assert.equal(refreshed.status, 'regenerated');
  assert.equal(refreshed.data_level, 'sufficient_data');
  assert.equal(refreshed.preliminary, false);
  assert.equal(reused.status, 'cached');
  assert.equal(providerCalls, 2);
});

test('provider failure keeps and marks the prior cached insight while canonical metrics remain available', async () => {
  const harness = createHarness();
  harness.setSaved({
    input_fingerprint: 'older-fingerprint',
    insight: generatedInsight('Previously generated evidence.'),
    generated_at: '2026-09-08T00:00:00.000Z',
    stale_at: null,
  });
  const before = harness.getSaved();
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([1, 1, 1, 1, 0]),
    actorId: 2,
    pool: harness.pool,
    generateInsight: async () => { throw new Error('mock provider unavailable'); },
  });

  assert.equal(state.status, 'unavailable');
  assert.equal(state.is_stale, true);
  assert.deepEqual(state.insight, before.insight);
  assert.deepEqual(harness.getSaved(), before);
  assert.ok(harness.calls.some(({ sql }) => sql === 'rollback'));
});
