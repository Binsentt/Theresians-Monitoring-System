const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GROUNDING_POLICY_VERSION,
} = require('./studentAnalyticsGrounding.utils');
const {
  buildGroundedInsightInput,
  buildInsightFingerprint,
  generateGroundedStudentInsight,
} = require('./studentAnalyticsInsight.utils');

const metrics = {
  validResultCount: 5,
  correctAnswers: 3,
  incorrectAnswers: 2,
  totalQuestions: 5,
  accuracy: 60,
  gameScore: 12,
  totalProgress: 42,
  completedQuests: 1,
  currentQuest: 'Fraction Forest',
  difficultyBreakdown: {
    easy: { accuracy: 100 },
    medium: { accuracy: 50 },
    hard: { accuracy: null },
  },
  topicPerformance: [{ topic: 'Fractions', accuracy: 60, correctAnswers: 3, totalQuestions: 5 }],
  playtimeMinutes: 24,
};

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  headers: { get: () => null },
  json: async () => body,
});

const validSelection = {
  grounding_policy_version: GROUNDING_POLICY_VERSION,
  performance_claim_ids: ['overall_accuracy', 'current_quest'],
  strength_claim_ids: ['difficulty_easy_strength'],
  weakness_claim_ids: ['difficulty_normal_weakness'],
  recommendation_claim_ids: ['practice_difficulty_normal'],
};

const inputFor = () => buildGroundedInsightInput({ gradeLevel: 'Grade 3', metrics });

test('uses only minimized deterministic facts and policy version in grounded insight input', () => {
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 3', metrics, studentId: 44, name: 'Do not include' });

  assert.deepEqual(input, {
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    grade: 'Grade 3',
    results_recorded: 5,
    correct_answers: 3,
    incorrect_answers: 2,
    total_questions: 5,
    accuracy: 60,
    game_score: 12,
    total_progress: 42,
    completed_quests: 1,
    current_quest: 'Fraction Forest',
    difficulty_accuracy: { easy: 100, medium: 50, hard: null },
    topic_performance: [{ topic: 'Fractions', accuracy: 60, correct_answers: 3, total_questions: 5 }],
    playtime_minutes: 24,
  });
  assert.equal(JSON.stringify(input).includes('Do not include'), false);
  assert.equal(JSON.stringify(input).includes('44'), false);
});

test('uses a stable cache fingerprint and invalidates pre-policy and changed metrics', () => {
  const input = inputFor();
  const changed = buildGroundedInsightInput({
    gradeLevel: 'Grade 3',
    metrics: { ...metrics, correctAnswers: 4, accuracy: 80 },
  });
  const prePolicyInput = { ...input };
  delete prePolicyInput.grounding_policy_version;

  assert.equal(buildInsightFingerprint(input), buildInsightFingerprint(input));
  assert.notEqual(buildInsightFingerprint(input), buildInsightFingerprint(changed));
  assert.notEqual(buildInsightFingerprint(input), buildInsightFingerprint(prePolicyInput));
});

test('uses a mocked claim selection and returns only backend-rendered text', async () => {
  let providerRequest = null;
  const insight = await generateGroundedStudentInsight({
    input: inputFor(),
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      providerRequest = { url, body: JSON.parse(options.body) };
      return jsonResponse({ output_text: JSON.stringify(validSelection) });
    },
  });

  assert.equal(providerRequest.url, 'https://api.openai.com/v1/responses');
  assert.equal(providerRequest.body.text.format.schema.additionalProperties, false);
  assert.match(insight.performance_insight, /Recorded overall accuracy is 60%/);
  assert.match(insight.performance_insight, /Current quest: Fraction Forest/);
  assert.deepEqual(insight.strengths, ['Recorded Easy accuracy is 100%, meeting the current positive-evidence boundary.']);
  assert.equal(JSON.stringify(insight).includes('85%'), false);
});

test('rejects provider free-form insight text instead of displaying it', async () => {
  await assert.rejects(
    generateGroundedStudentInsight({
      input: inputFor(),
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ output_text: JSON.stringify({
        performance_insight: 'The student reached Wizard Tower and improved to 85%.',
        strengths: ['Strong in subtraction.'],
        weaknesses: [],
        recommendations: [],
      }) }),
    }),
    (error) => error.code === 'ANALYTICS_AI_INVALID_RESPONSE' && /claim|grounding|structured/i.test(error.message)
  );
});

test('rejects malformed, unknown, wrong-category, stale-policy, and extra provider output', async () => {
  const invalidOutputs = [
    '{not-json',
    JSON.stringify({ ...validSelection, performance_claim_ids: ['accuracy_85_percent'] }),
    JSON.stringify({ ...validSelection, strength_claim_ids: ['overall_accuracy'] }),
    JSON.stringify({ ...validSelection, grounding_policy_version: 'grounded-claims-v0' }),
    JSON.stringify({ ...validSelection, narrative: 'I improved.' }),
  ];

  for (const outputText of invalidOutputs) {
    await assert.rejects(
      generateGroundedStudentInsight({
        input: inputFor(),
        apiKey: 'test-key',
        fetchImpl: async () => jsonResponse({ output_text: outputText }),
      }),
      (error) => error.code === 'ANALYTICS_AI_INVALID_RESPONSE'
    );
  }
});

test('returns a safe unavailable error for mocked provider timeout and failure', async () => {
  await assert.rejects(
    generateGroundedStudentInsight({
      input: inputFor(),
      apiKey: 'test-key',
      fetchImpl: async () => { throw new Error('network unavailable'); },
    }),
    (error) => error.code === 'ANALYTICS_AI_GENERATION_FAILED'
  );
  await assert.rejects(
    generateGroundedStudentInsight({
      input: inputFor(),
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ error: { type: 'server_error' } }, { ok: false, status: 503 }),
    }),
    (error) => error.code === 'ANALYTICS_AI_GENERATION_FAILED'
  );
});

test('never uses a live provider without an injected mock in tests', async () => {
  await assert.rejects(
    generateGroundedStudentInsight({ input: inputFor(), apiKey: '' }),
    (error) => error.code === 'ANALYTICS_AI_NOT_CONFIGURED'
  );
});
