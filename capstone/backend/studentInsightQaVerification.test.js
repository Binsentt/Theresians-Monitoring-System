const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveStudentAiInsight } = require('./studentAiInsight.service');
const { runInsightCacheVerification } = require('./studentInsightQaVerification');

const empty = { rows: [] };
const compact = (sql) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

const createHarness = () => {
  let saved = null;
  let generatedAt = 0;
  const query = async (rawSql, params = []) => {
    const sql = compact(rawSql);
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
    pool: { query, connect: async () => ({ query, release() {} }) },
    getSaved: () => structuredClone(saved),
  };
};

const metrics = {
  validResultCount: 5,
  correctAnswers: 3,
  incorrectAnswers: 2,
  totalQuestions: 5,
  accuracy: 60,
  gameScore: 3,
  totalProgressVerified: false,
  completedQuests: 0,
  currentQuest: 'first-bandit-math-challenge',
  currentDifficulty: 'Easy',
  difficultyBreakdown: { easy: { accuracy: 60 }, medium: { accuracy: null }, hard: { accuracy: null } },
  topicPerformance: [],
  playtimeMinutes: 0,
};

const generatedInsight = {
  performance_insight: 'Recorded overall accuracy is 60%.',
  strengths: [],
  weaknesses: [],
  recommendations: [],
};

test('failed first insight generation skips cache verification and never makes a second provider call', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const result = await runInsightCacheVerification({
    request: { studentId: 44, gradeLevel: 'Grade 1', metrics: { ...metrics } },
    resolveInsight: (request) => resolveStudentAiInsight({
      ...request,
      aiGenerationEnabled: true,
      pool: harness.pool,
      generateInsight: async () => {
        providerCalls += 1;
        throw new Error('provider unavailable');
      },
    }),
  });

  assert.equal(result.first.status, 'unavailable');
  assert.equal(result.cacheVerification, 'skipped');
  assert.equal(result.second, null);
  assert.equal(providerCalls, 1);
  assert.equal(harness.getSaved(), null);
});

test('successful insight generation persists once and unchanged evidence verifies a cache hit without another provider call', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const result = await runInsightCacheVerification({
    request: { studentId: 44, gradeLevel: 'Grade 1', metrics: { ...metrics } },
    resolveInsight: (request) => resolveStudentAiInsight({
      ...request,
      aiGenerationEnabled: true,
      pool: harness.pool,
      generateInsight: async () => {
        providerCalls += 1;
        return generatedInsight;
      },
    }),
  });

  assert.equal(result.first.status, 'generated');
  assert.equal(result.second.status, 'cached');
  assert.equal(result.cacheVerification, 'hit');
  assert.equal(providerCalls, 1);
  assert.deepEqual(harness.getSaved().insight, generatedInsight);
});
