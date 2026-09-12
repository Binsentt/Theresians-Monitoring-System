const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GROUNDING_POLICY_VERSION,
} = require('./studentAnalyticsGrounding.utils');
const {
  buildGroundedInsightInput,
  buildInsightFingerprint,
  ANALYTICS_INSIGHT_MAX_OUTPUT_TOKENS,
  generateGroundedStudentInsight: generateGroundedStudentInsightWithPolicy,
} = require('./studentAnalyticsInsight.utils');

const generateGroundedStudentInsight = (input) => generateGroundedStudentInsightWithPolicy({
  aiGenerationEnabled: true,
  ...input,
});

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
    metrics_definition_version: 'student-metrics-v2',
    grade: 'Grade 3',
    results_recorded: 5,
    correct_answers: 3,
    incorrect_answers: 2,
    total_questions: 5,
    accuracy: 60,
    game_score: 12,
    total_progress: null,
    total_progress_verified: false,
    total_progress_source: 'unavailable',
    completed_quests: 1,
    current_quest: 'Fraction Forest',
    current_difficulty: null,
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

test('metrics semantics and current difficulty are fingerprinted without changing the grounding policy', () => {
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics: { ...metrics, currentDifficulty: 'Easy', totalProgressVerified: false } });
  assert.equal(input.grounding_policy_version, 'grounded-claims-v1');
  assert.equal(input.metrics_definition_version, 'student-metrics-v2');
  assert.equal(input.current_difficulty, 'Easy');
  assert.equal(input.total_progress_verified, false);
  const legacy = { ...input };
  delete legacy.metrics_definition_version;
  assert.notEqual(buildInsightFingerprint(input), buildInsightFingerprint(legacy));
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
  assert.ok(Number.isInteger(providerRequest.body.max_output_tokens));
  assert.equal(providerRequest.body.max_output_tokens, ANALYTICS_INSIGHT_MAX_OUTPUT_TOKENS);
  assert.ok(providerRequest.body.max_output_tokens >= 900);
  assert.equal(providerRequest.body.text.format.schema.additionalProperties, false);
  assert.match(insight.performance_insight, /Recorded overall accuracy is 60%/);
  assert.match(insight.performance_insight, /Current quest: Fraction Forest/);
  assert.deepEqual(insight.strengths, ['Recorded Easy accuracy is 100%, meeting the current positive-evidence boundary.']);
  assert.equal(JSON.stringify(insight).includes('85%'), false);
});

test('rejects an incomplete grounded claim selection instead of rendering partial insight output', async () => {
  const incompleteSelection = {
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['overall_accuracy'],
  };

  await assert.rejects(
    generateGroundedStudentInsight({
      input: inputFor(),
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ output_text: JSON.stringify(incompleteSelection) }),
    }),
    (error) => error.code === 'ANALYTICS_AI_INVALID_RESPONSE'
  );
});

test('paused grounded insight returns AI_PAUSED before any provider request', async () => {
  let providerCalls = 0;
  await assert.rejects(
    generateGroundedStudentInsight({
      input: inputFor(),
      aiGenerationEnabled: false,
      apiKey: 'provider-key-must-not-be-used',
      fetchImpl: async () => {
        providerCalls += 1;
      },
    }),
    (error) => error.code === 'AI_PAUSED'
  );
  assert.equal(providerCalls, 0);
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

const diagnosticsFor = async (body, { expectSuccess = false } = {}) => {
  let diagnostics = null;
  const result = await (async () => {
    try {
      const value = await generateGroundedStudentInsight({
        input: inputFor(),
        apiKey: 'test-key',
        onDiagnostics: (valueToCapture) => { diagnostics = valueToCapture; },
        fetchImpl: async () => jsonResponse(body),
      });
      if (!expectSuccess) assert.fail('expected the structured response to be rejected');
      return value;
    } catch (error) {
      if (expectSuccess) throw error;
      assert.equal(error.code, 'ANALYTICS_AI_INVALID_RESPONSE');
      return null;
    }
  })();
  assert.ok(diagnostics);
  return { diagnostics, result };
};

test('records distinct safe diagnostics for response text, parse, shape, policy, claim, and render stages', async () => {
  const valid = { ...validSelection };
  const cases = [
    ['missing text', {}, 'RESPONSE_TEXT_MISSING'],
    ['malformed JSON', { output_text: '{not-json' }, 'RESPONSE_JSON_PARSE_FAILED'],
    ['wrong top-level shape', { output_text: JSON.stringify([]) }, 'RESPONSE_SHAPE_INVALID'],
    ['bad policy', { output_text: JSON.stringify({ ...valid, grounding_policy_version: 'grounded-claims-v0' }) }, 'POLICY_VERSION_INVALID'],
    ['unknown claim', { output_text: JSON.stringify({ ...valid, performance_claim_ids: ['unknown_claim'] }) }, 'CLAIM_ID_UNKNOWN'],
    ['duplicate claim', { output_text: JSON.stringify({ ...valid, performance_claim_ids: ['overall_accuracy', 'overall_accuracy'] }) }, 'CLAIM_ID_DUPLICATE'],
    ['unsupported claim category', { output_text: JSON.stringify({ ...valid, performance_claim_ids: ['difficulty_easy_strength'] }) }, 'CLAIM_ID_UNKNOWN'],
    ['unsupported recommendation support', { output_text: JSON.stringify({ ...valid, weakness_claim_ids: [] }) }, 'CLAIM_SUPPORT_INVALID'],
  ];

  for (const [label, body, stage] of cases) {
    const { diagnostics } = await diagnosticsFor(body);
    assert.equal(diagnostics.validationStage, stage, label);
    assert.equal(typeof diagnostics.outputTextPresent, 'boolean');
    assert.ok(diagnostics.jsonParseSucceeded === null || typeof diagnostics.jsonParseSucceeded === 'boolean');
    assert.ok(diagnostics.persistenceSucceeded === null || typeof diagnostics.persistenceSucceeded === 'boolean');
  }
});

test('records a successful structured response without retaining model text', async () => {
  const { diagnostics, result } = await diagnosticsFor({ output_text: JSON.stringify(validSelection) }, { expectSuccess: true });
  assert.equal(diagnostics.validationStage, 'VALIDATION_PASSED');
  assert.equal(diagnostics.jsonParseSucceeded, true);
  assert.equal(diagnostics.renderedOutputValidation, true);
  assert.equal(diagnostics.persistenceSucceeded, null);
  assert.deepEqual([...diagnostics.topLevelKeys].sort(), [
    'grounding_policy_version',
    'performance_claim_ids',
    'recommendation_claim_ids',
    'strength_claim_ids',
    'weakness_claim_ids',
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'rawResponse'), false);
  assert.equal(JSON.stringify(diagnostics).includes('Recorded overall accuracy'), false);
  assert.match(result.performance_insight, /Recorded overall accuracy/);
});
