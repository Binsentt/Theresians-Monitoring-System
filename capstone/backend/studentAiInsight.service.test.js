const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveStudentAiInsight: resolveStudentAiInsightWithPolicy } = require('./studentAiInsight.service');
const { buildStudentAnalyticsMetrics } = require('./studentAnalyticsMetrics.utils');
const { buildGroundedInsightInput, buildInsightFingerprint } = require('./studentAnalyticsInsight.utils');
const {
  buildGroundedClaimCatalog,
  renderValidatedClaimSelection,
  GROUNDING_POLICY_VERSION,
} = require('./studentAnalyticsGrounding.utils');

const resolveStudentAiInsight = (input) => resolveStudentAiInsightWithPolicy({
  aiGenerationEnabled: true,
  ...input,
});

const empty = { rows: [] };
const compact = (sql) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

const createHarness = ({ insertError = null } = {}) => {
  let saved = null;
  let generatedAt = 0;
  const calls = [];
  const query = async (rawSql, params = []) => {
    const sql = compact(rawSql);
    calls.push({ sql, params });
    if (sql.includes('from public.student_ai_insights')) return { rows: saved ? [structuredClone(saved)] : [] };
    if (sql.includes('insert into public.student_ai_insights')) {
      if (insertError) throw insertError;
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
    topicLinkedEvidenceCount: 0,
    questTopicLinkedEvidenceCount: 0,
    unmappedQuestTopicIncorrectAnswers: 0,
    questTopicPerformance: [],
    playtimeMinutes: 0,
  };
};

const topicMetricsFor = (answers, {
  taskId = 'oakleaf-bandits',
  topicId = 'subtraction',
  topic = 'Subtraction',
  gradeLevel = 'Grade 1',
} = {}) => {
  const base = metricsFor(answers);
  const correctAnswers = answers.filter(Boolean).length;
  const totalQuestions = answers.length;
  const accuracy = totalQuestions ? Number(((correctAnswers / totalQuestions) * 100).toFixed(2)) : null;
  return {
    ...base,
    topicPerformance: [{
      topicId, topic, gradeLevel, correctAnswers,
      incorrectAnswers: totalQuestions - correctAnswers, totalQuestions, accuracy,
    }],
    topicLinkedEvidenceCount: totalQuestions,
    questTopicLinkedEvidenceCount: totalQuestions,
    unmappedQuestTopicIncorrectAnswers: 0,
    questTopicPerformance: [{
      canonicalTaskId: taskId, topicId, topic, gradeLevel, correctAnswers,
      incorrectAnswers: totalQuestions - correctAnswers, totalQuestions, accuracy,
    }],
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
  assert.equal(state.deterministic_evidence.general_performance.summary, null);
  assert.deepEqual(state.deterministic_evidence.general_performance.strengths, []);
  assert.deepEqual(state.deterministic_evidence.general_performance.weaknesses, []);
  assert.equal(providerCalls, 0);
  assert.equal(harness.getSaved(), null);
});

test('zero valid results retain authoritative completed non-graded quest evidence without generating AI output', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([]),
    activityLogs: [{
      canonical_activity_id: 'task_completed',
      canonical_task_id: 'go-to-school',
      map_id: 'city_of_knowledge',
      created_at: '2026-09-10T00:00:00.000Z',
    }],
    actorId: 1,
    pool: harness.pool,
    generateInsight: async () => { providerCalls += 1; return generatedInsight('unused'); },
  });

  assert.equal(state.status, 'no_data');
  assert.equal(state.data_level, 'no_data');
  assert.equal(state.valid_result_count, 0);
  assert.equal(state.insight.performance_insight, undefined);
  const quest = state.insight.quest_insights.find((item) => item.canonical_task_id === 'go-to-school');
  assert.equal(quest.completion_status, 'completed');
  assert.equal(quest.summary, 'Quest completed — no graded questions required.');
  assert.equal(providerCalls, 0);
  assert.equal(harness.getSaved(), null);
});

test('current-cycle completion milestones reach Per-Quest Evidence without being treated as quiz results', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([]),
    completedMilestones: [{
      canonical_task_id: 'go-to-teachers-house',
      player_facing: true,
      completed_at: '2026-10-30T12:00:00.000Z',
      learning_cycle_version: 3,
    }],
    pool: harness.pool,
    generateInsight: async () => { providerCalls += 1; return generatedInsight('unused'); },
  });
  const quest = state.insight.quest_insights.find((item) => item.canonical_task_id === 'go-to-teachers-house');

  assert.equal(state.status, 'no_data');
  assert.equal(quest.completion_status, 'completed');
  assert.equal(quest.quiz_status, 'not_required');
  assert.equal(quest.completion_date, '2026-10-30T12:00:00.000Z');
  assert.equal(quest.summary, 'Quest completed — no graded questions required.');
  assert.equal(quest.total_questions, 0);
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

test('five graded answers with two correct and three incorrect produce grounded weakness and recommendation evidence', async () => {
  const quizSessions = [1, 0, 0, 1, 0].map((score, index) => ({
    score,
    total_items: 1,
    difficulty: 'Easy',
    math_topic: 'Oakleaf',
    canonical_topic_id: 'subtraction',
    canonical_grade_level: 'Grade 1',
    canonical_difficulty: 'Easy',
    canonical_task_id: 'first-bandit-math-challenge',
    result_event_id: `qa-battle-${index + 1}`,
  }));
  const metrics = buildStudentAnalyticsMetrics({
    progress: { score: 17, current_quest: 'First Bandit' },
    quizSessions,
  });

  assert.equal(metrics.validResultCount, 5);
  assert.equal(metrics.correctAnswers, 2);
  assert.equal(metrics.incorrectAnswers, 3);
  assert.equal(metrics.totalQuestions, 5);
  assert.equal(metrics.accuracy, 40);
  assert.equal(metrics.gameScore, 2);

  const { buildGroundedInsightInput } = require('./studentAnalyticsInsight.utils');
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics });
  const catalog = buildGroundedClaimCatalog(input);
  const grounded = renderValidatedClaimSelection({
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    performance_claim_ids: ['results_recorded', 'answer_counts', 'overall_accuracy'],
    strength_claim_ids: [],
    weakness_claim_ids: ['quest_first_bandit_math_challenge_topic_grade_1_subtraction_weakness'],
  }, catalog);
  assert.match(grounded.performance_insight, /40%/);
  assert.match(grounded.weaknesses[0], /40%/);
  assert.deepEqual(grounded.recommendations, [
    'Keep practicing Grade 1 Subtraction and review the 3 missed questions from First Bandit Math Challenge. More recorded answers are needed before judging a persistent weakness.',
  ]);

  const harness = createHarness();
  let providerCalls = 0;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics,
    actorId: 1,
    pool: harness.pool,
    generateInsight: async () => {
      providerCalls += 1;
      return grounded;
    },
  });
  assert.equal(state.status, 'generated');
  assert.equal(state.data_level, 'sufficient_data');
  assert.equal(state.preliminary, false);
  assert.deepEqual(state.insight.recommendations, grounded.recommendations);

  const cached = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics,
    actorId: 2,
    pool: harness.pool,
    generateInsight: async () => {
      providerCalls += 1;
      return grounded;
    },
  });
  assert.equal(cached.status, 'cached');
  assert.equal(providerCalls, 1);
});

test('current canonical topic evidence refreshes cached weakness and recommendation text without provider availability', async () => {
  const harness = createHarness();
  const metrics = {
    ...metricsFor([0, 0, 0, 1, 1]),
    topicPerformance: [{
      topicId: 'subtraction', topic: 'Subtraction', gradeLevel: 'Grade 1',
      correctAnswers: 2, incorrectAnswers: 3, totalQuestions: 5, accuracy: 40,
    }],
    topicLinkedEvidenceCount: 5,
    questTopicLinkedEvidenceCount: 5,
    unmappedQuestTopicIncorrectAnswers: 0,
    questTopicPerformance: [{
      canonicalTaskId: 'oakleaf-bandits', taskLabel: 'Oakleaf Bandits',
      topicId: 'subtraction', topic: 'Subtraction', gradeLevel: 'Grade 1',
      correctAnswers: 2, incorrectAnswers: 3, totalQuestions: 5, accuracy: 40,
    }],
  };
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics });
  harness.setSaved({
    input_fingerprint: buildInsightFingerprint(input),
    insight: generatedInsight('Older insight.'),
    generated_at: '2026-09-09T00:00:00.000Z',
    stale_at: null,
  });
  let providerCalls = 0;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics,
    pool: harness.pool,
    generateInsight: async () => { providerCalls += 1; return generatedInsight('unused'); },
  });

  assert.equal(state.status, 'cached');
  assert.equal(providerCalls, 0);
  assert.equal(state.topic_evidence_status, 'weaknesses_identified');
  assert.match(state.insight.weaknesses[0], /Subtraction — Oakleaf Bandits.*40%/);
  assert.match(state.insight.recommendations[0], /Keep practicing Grade 1 Subtraction.*Oakleaf Bandits/);
});

test('current Math strengths replace retired cached quest-completion strengths', async () => {
  const harness = createHarness();
  const metrics = {
    ...metricsFor([1, 1, 1, 1, 1]),
    completedQuests: 3,
    topicPerformance: [{ topicId: 'addition', gradeLevel: 'Grade 1', correctAnswers: 5, totalQuestions: 5 }],
    questTopicPerformance: [{ canonicalTaskId: 'oakleaf-bandits', topicId: 'addition', gradeLevel: 'Grade 1', correctAnswers: 5, totalQuestions: 5 }],
  };
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics });
  harness.setSaved({
    input_fingerprint: buildInsightFingerprint(input),
    insight: { ...generatedInsight('Previous output.'), strengths: ['Recorded progress includes 3 completed quests.'] },
    generated_at: '2026-09-09T00:00:00.000Z',
    stale_at: null,
  });
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics,
    pool: harness.pool,
    generateInsight: async () => { throw new Error('Current cache should not call provider.'); },
  });
  assert.equal(state.status, 'cached');
  assert.deepEqual(state.insight.strengths, [
    'General evidence (overall performance, not a specific Mathematics topic): 5 of 5 recorded answers were correct (100%).',
    'Strong performance in Addition: 5 of 5 recorded answers correct (100%).',
  ]);
});

test('current canonical non-graded completion replaces stale cached per-quest no-evidence wording', async () => {
  const harness = createHarness();
  const metrics = metricsFor([1, 1, 1, 1, 1]);
  const input = buildGroundedInsightInput({
    gradeLevel: 'Grade 1',
    metrics,
    activityLogs: [{
      canonical_activity_id: 'task_completed',
      canonical_task_id: 'go-to-school',
      current_quest: 'Go to the School.',
    }],
  });
  harness.setSaved({
    input_fingerprint: buildInsightFingerprint(input),
    insight: {
      ...generatedInsight('Previously generated.'),
      quest_insights: [{
        canonical_task_id: 'go-to-school',
        label: 'Go to the School.',
        summary: 'No graded or timing evidence is recorded for this task yet.',
      }],
    },
    generated_at: '2026-09-09T00:00:00.000Z',
    stale_at: null,
  });

  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics,
    activityLogs: [{
      canonical_activity_id: 'task_completed',
      canonical_task_id: 'go-to-school',
      current_quest: 'Go to the School.',
    }],
    pool: harness.pool,
    generateInsight: async () => { throw new Error('Current cache should not call provider.'); },
  });

  assert.equal(state.status, 'cached');
  const completedSchool = state.insight.quest_insights.find((quest) => quest.canonical_task_id === 'go-to-school');
  assert.equal(completedSchool.summary, 'Quest completed — no graded questions required.');
});

test('paused insight with no cache returns a stable state without provider, transaction, or write', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([1, 1, 1, 0]),
    actorId: 1,
    aiGenerationEnabled: false,
    pool: harness.pool,
    generateInsight: async () => {
      providerCalls += 1;
      return generatedInsight('must not run');
    },
  });

  assert.equal(state.status, 'paused');
  assert.equal(state.code, 'AI_PAUSED');
  assert.equal(state.insight, null);
  assert.equal(state.is_stale, false);
  assert.equal(providerCalls, 0);
  assert.equal(harness.calls.some(({ sql }) => sql === 'begin'), false);
  assert.equal(harness.calls.some(({ sql }) => sql.includes('insert into public.student_ai_insights')), false);
});

test('paused insight with an empty cache still returns deterministic current-cycle topic evidence', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    learningCycleVersion: 3,
    metrics: topicMetricsFor([1, 1, 1, 1, 1]),
    completedMilestones: [{
      canonical_task_id: 'go-to-school', player_facing: true,
      learning_cycle_version: 3, completed_at: '2026-10-30T12:00:00.000Z',
    }],
    aiGenerationEnabled: false,
    pool: harness.pool,
    generateInsight: async () => { providerCalls += 1; return generatedInsight('must not run'); },
  });

  assert.equal(state.status, 'paused');
  assert.equal(state.insight, null, 'no generated AI output is claimed');
  assert.equal(state.deterministic_evidence.topic_evidence_status, 'perfect_recorded_results');
  assert.deepEqual(state.deterministic_evidence.general_performance.strengths, [
    'General evidence (overall performance, not a specific Mathematics topic): 5 of 5 recorded answers were correct (100%).',
  ]);
  assert.deepEqual(state.deterministic_evidence.topic_specific.strengths, [
    'Strong performance in Subtraction: 5 of 5 recorded answers correct (100%).',
  ]);
  assert.deepEqual(state.deterministic_evidence.strengths, [
    ...state.deterministic_evidence.general_performance.strengths,
    ...state.deterministic_evidence.topic_specific.strengths,
  ]);
  assert.deepEqual(state.deterministic_evidence.weaknesses, []);
  assert.deepEqual(state.deterministic_evidence.recommendations, []);
  assert.equal(state.deterministic_evidence.quest_insights.find((quest) => quest.canonical_task_id === 'go-to-school').completion_status, 'completed');
  assert.equal(providerCalls, 0);
  assert.equal(harness.getSaved(), null);
});

for (const [label, aiGenerationEnabled, expectedStatus, expectedProviderCalls] of [
  ['AI paused', false, 'paused', 0],
  ['provider failed', true, 'unavailable', 1],
]) {
test(`blank cache preserves general current-cycle evidence when ${label}`, async () => {
  const harness = createHarness();
  const answers = [...Array(53).fill(true), ...Array(10).fill(false)];
  let providerCalls = 0;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    learningCycleVersion: 3,
    metrics: metricsFor(answers),
    actorId: 1,
    pool: harness.pool,
    logger: { error() {} },
    aiGenerationEnabled,
    generateInsight: async () => {
      providerCalls += 1;
      throw new Error('synthetic provider failure');
    },
  });

  assert.equal(state.status, expectedStatus);
  assert.equal(state.insight, null, 'deterministic general evidence is not represented as generated AI output');
  assert.deepEqual(state.deterministic_evidence.general_performance.strengths, [
    'General evidence (overall performance, not a specific Mathematics topic): 53 of 63 recorded answers were correct (84.1%).',
  ]);
  assert.deepEqual(state.deterministic_evidence.general_performance.weaknesses, [
    'General evidence (not topic-specific): 10 of 63 recorded answers were incorrect. The available records do not establish which Mathematics topic those answers involved.',
  ]);
  assert.deepEqual(state.deterministic_evidence.general_performance.recommendations, [
    'General practice: review the solutions for the 10 recorded incorrect answers and practice similar Mathematics problems. This is not a topic-specific recommendation.',
  ]);
  assert.deepEqual(state.deterministic_evidence.topic_specific, {
    strengths: [], weaknesses: [], recommendations: [],
  });
  assert.equal(state.deterministic_evidence.strengths[0], state.deterministic_evidence.general_performance.strengths[0]);
  assert.equal(state.deterministic_evidence.weaknesses[0], state.deterministic_evidence.general_performance.weaknesses[0]);
  assert.equal(providerCalls, expectedProviderCalls);
  assert.equal(harness.getSaved(), null);
});
}

test('successful generation keeps current general guidance when topic metadata is unavailable', async () => {
  const harness = createHarness();
  const answers = [...Array(53).fill(true), ...Array(10).fill(false)];
  let providerEvidence = null;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    learningCycleVersion: 3,
    metrics: metricsFor(answers),
    pool: harness.pool,
    generateInsight: async ({ input }) => {
      providerEvidence = input.general_performance;
      return generatedInsight('Recorded overall results show strong accuracy with unlinked misses.');
    },
  });

  assert.equal(state.status, 'generated');
  assert.equal(state.insight.performance_insight, 'Recorded overall results show strong accuracy with unlinked misses.');
  assert.match(providerEvidence.summary, /53 of 63 answers were correct/);
  assert.equal(state.insight.topic_evidence_status, 'topic_metadata_unavailable');
  assert.equal(state.insight.strengths[0], state.deterministic_evidence.general_performance.strengths[0]);
  assert.equal(state.insight.weaknesses[0], state.deterministic_evidence.general_performance.weaknesses[0]);
  assert.equal(state.insight.recommendations[0], state.deterministic_evidence.general_performance.recommendations[0]);
  assert.deepEqual(state.deterministic_evidence.topic_specific, {
    strengths: [], weaknesses: [], recommendations: [],
  });
  assert.deepEqual(harness.getSaved().insight, state.insight);
});

test('blank-cache provider failure exposes evidence-based topic guidance and accepted-save quest evidence; retry can generate later', async () => {
  const harness = createHarness();
  const metrics = topicMetricsFor([0, 0, 0, 1, 1]);
  const activityLogs = [{
    canonical_activity_id: 'task_completed', canonical_task_id: 'go-to-school',
    canonical_quest_id: 'city-of-knowledge', map_id: 'city_of_knowledge',
    is_player_facing: true, quest_graph_version: 'oakleaf-city-pinehill-v1',
    completed_at: '2026-10-30T12:00:00.000Z',
  }];
  const completedMilestones = [{
    canonical_task_id: 'go-to-school', player_facing: true,
    learning_cycle_version: 3, completed_at: '2026-10-30T12:00:00.000Z',
  }];
  const quizSessions = [
    { canonical_task_id: 'pinehill-bandits', canonical_battle_id: 'pinehill_bandits2', score: 0, total_items: 1, result_event_id: 'synthetic-guard-2', played_at: '2026-10-30T12:01:00.000Z' },
    { canonical_task_id: 'pinehill-bandits', canonical_battle_id: 'pinehill_bandits4', score: 0, total_items: 1, result_event_id: 'synthetic-guard-4', played_at: '2026-10-30T12:02:00.000Z' },
    { canonical_task_id: 'oakleaf-boss-bandit', score: 1, total_items: 1, result_event_id: 'synthetic-boss', played_at: '2026-10-30T12:03:00.000Z' },
  ];
  const args = {
    studentId: 44, gradeLevel: 'Grade 1', learningCycleVersion: 3,
    metrics, activityLogs, completedMilestones, quizSessions, pool: harness.pool,
  };
  const unavailable = await resolveStudentAiInsight({
    ...args,
    generateInsight: async () => { throw new Error('synthetic provider outage'); },
  });

  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.insight, null, 'provider failure does not create or imply generated AI prose');
  assert.equal(unavailable.deterministic_evidence.topic_evidence_status, 'weaknesses_identified');
  assert.match(unavailable.deterministic_evidence.weaknesses[0], /Subtraction — Oakleaf Bandits/);
  assert.match(unavailable.deterministic_evidence.recommendations[0], /Keep practicing Grade 1 Subtraction/);
  const completedExploration = unavailable.deterministic_evidence.quest_insights.find((quest) => quest.canonical_task_id === 'go-to-school');
  assert.equal(completedExploration.completion_status, 'completed');
  assert.equal(completedExploration.quiz_status, 'not_required');
  assert.equal(completedExploration.total_questions, 0);
  assert.equal(completedExploration.summary, 'Quest completed — no graded questions required.');
  const guards = unavailable.deterministic_evidence.quest_insights.find((quest) => quest.canonical_task_id === 'pinehill-bandits');
  assert.deepEqual(guards.encounters, [{ id: 'pinehill_bandits2', label: 'Guard 2' }, { id: 'pinehill_bandits4', label: 'Guard 4' }]);
  assert.equal(guards.encounter_reporting, 'individual_recorded_encounters');
  assert.equal(guards.total_questions, 2);
  const boss = unavailable.deterministic_evidence.quest_insights.find((quest) => quest.canonical_task_id === 'oakleaf-boss-bandit');
  assert.equal(boss.encounters.length, 0);
  assert.equal(boss.encounter_reporting, 'task_aggregate');
  assert.equal(boss.total_questions, 1);
  assert.deepEqual(harness.getSaved(), null);

  const retry = await resolveStudentAiInsight({
    ...args, forceRefresh: true,
    generateInsight: async () => generatedInsight('A later authorized refresh succeeded.'),
  });
  assert.equal(retry.status, 'generated');
  assert.equal(retry.insight.performance_insight, 'A later authorized refresh succeeded.');
  assert.deepEqual(retry.insight.weaknesses, unavailable.deterministic_evidence.weaknesses);
  assert.deepEqual(retry.insight.quest_insights, unavailable.deterministic_evidence.quest_insights);
});

test('provider failure without validated topic metadata reports the gap without inventing a topic', async () => {
  const harness = createHarness();
  const state = await resolveStudentAiInsight({
    studentId: 44, gradeLevel: 'Grade 1', metrics: metricsFor([0, 0, 0, 1, 1]), pool: harness.pool,
    generateInsight: async () => { throw new Error('synthetic provider outage'); },
  });

  assert.equal(state.status, 'unavailable');
  assert.equal(state.insight, null);
  assert.equal(state.deterministic_evidence.topic_evidence_status, 'topic_metadata_unavailable');
  assert.deepEqual(state.deterministic_evidence.strengths, []);
  assert.deepEqual(state.deterministic_evidence.general_performance.weaknesses, [
    'General evidence (not topic-specific): 3 recorded incorrect answers were without a validated topic. This is limited evidence and does not establish a persistent weakness or topic.',
  ]);
  assert.deepEqual(state.deterministic_evidence.topic_specific.weaknesses, []);
  assert.doesNotMatch(state.deterministic_evidence.weaknesses.join(' '), /Subtraction|Addition|Multiplication/);
  assert.doesNotMatch(state.deterministic_evidence.recommendations.join(' '), /Subtraction|Addition|Multiplication/);
});

test('paused insight preserves a stale genuine cache with its timestamp and makes no provider call', async () => {
  const harness = createHarness();
  harness.setSaved({
    input_fingerprint: 'older-fingerprint',
    insight: generatedInsight('Previously generated evidence.'),
    generated_at: '2026-09-08T00:00:00.000Z',
    stale_at: null,
  });
  let providerCalls = 0;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([1, 1, 1, 1, 0]),
    actorId: 2,
    aiGenerationEnabled: false,
    pool: harness.pool,
    generateInsight: async () => {
      providerCalls += 1;
      return generatedInsight('must not run');
    },
  });

  assert.equal(state.status, 'paused');
  assert.equal(state.code, 'AI_PAUSED');
  assert.equal(state.is_stale, true);
  assert.equal(state.generated_at, '2026-09-08T00:00:00.000Z');
  assert.equal(state.insight.performance_insight, 'Previously generated evidence.');
  assert.equal(providerCalls, 0);
  assert.equal(harness.calls.some(({ sql }) => sql === 'begin'), false);
});

test('paused insight exposes a matching genuine cache as current without a provider call', async () => {
  const harness = createHarness();
  const metrics = metricsFor([1, 1, 1, 0]);
  const { buildGroundedInsightInput, buildInsightFingerprint } = require('./studentAnalyticsInsight.utils');
  const fingerprint = buildInsightFingerprint(buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics }));
  harness.setSaved({
    input_fingerprint: fingerprint,
    insight: generatedInsight('Current generated evidence.'),
    generated_at: '2026-09-09T00:00:00.000Z',
    stale_at: null,
  });
  let providerCalls = 0;
  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics,
    actorId: 2,
    aiGenerationEnabled: false,
    pool: harness.pool,
    generateInsight: async () => {
      providerCalls += 1;
      return generatedInsight('must not run');
    },
  });

  assert.equal(state.status, 'paused');
  assert.equal(state.is_stale, false);
  assert.equal(state.insight.performance_insight, 'Current generated evidence.');
  assert.equal(providerCalls, 0);
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

test('alternating Student reads use separate insight caches and current-cycle evidence', async () => {
  const savedByStudent = new Map();
  const cacheReadStudentIds = [];
  const query = async (rawSql, params = []) => {
    const sql = compact(rawSql);
    if (sql.includes('from public.student_ai_insights')) {
      const studentId = Number(params[0]);
      cacheReadStudentIds.push(studentId);
      const saved = savedByStudent.get(studentId);
      return { rows: saved ? [structuredClone(saved)] : [] };
    }
    if (sql.includes('insert into public.student_ai_insights')) {
      const studentId = Number(params[0]);
      const saved = {
        input_fingerprint: params[1],
        insight: JSON.parse(params[2]),
        generated_at: `2026-11-07T00:00:0${savedByStudent.size + 1}.000Z`,
        stale_at: null,
      };
      savedByStudent.set(studentId, saved);
      return { rows: [{ insight: structuredClone(saved.insight), generated_at: saved.generated_at }] };
    }
    return empty;
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const studentAArgs = {
    studentId: 44,
    learningCycleVersion: 2,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([1, 1, 1, 1, 1]),
    pool,
  };
  const studentBArgs = {
    studentId: 45,
    learningCycleVersion: 4,
    gradeLevel: 'Grade 2',
    metrics: metricsFor([0, 0, 0, 0, 0]),
    pool,
  };

  const studentAFirst = await resolveStudentAiInsight({
    ...studentAArgs,
    generateInsight: async () => generatedInsight('Student A current-cycle insight.'),
  });
  const studentBFirst = await resolveStudentAiInsight({
    ...studentBArgs,
    generateInsight: async () => generatedInsight('Student B current-cycle insight.'),
  });
  const studentAAgain = await resolveStudentAiInsight({
    ...studentAArgs,
    generateInsight: async () => { throw new Error('Student A should use only Student A cache.'); },
  });
  const studentBAgain = await resolveStudentAiInsight({
    ...studentBArgs,
    generateInsight: async () => { throw new Error('Student B should use only Student B cache.'); },
  });

  assert.equal(studentAFirst.status, 'generated');
  assert.equal(studentBFirst.status, 'generated');
  assert.equal(studentAAgain.status, 'cached');
  assert.equal(studentBAgain.status, 'cached');
  assert.equal(studentAAgain.insight.performance_insight, 'Student A current-cycle insight.');
  assert.equal(studentBAgain.insight.performance_insight, 'Student B current-cycle insight.');
  assert.deepEqual(studentAAgain.deterministic_evidence.general_performance.strengths, [
    'General evidence (overall performance, not a specific Mathematics topic): 5 of 5 recorded answers were correct (100%).',
  ]);
  assert.deepEqual(studentBAgain.deterministic_evidence.general_performance.strengths, []);
  assert.deepEqual(studentBAgain.deterministic_evidence.general_performance.weaknesses, [
    'General evidence (not topic-specific): 5 of 5 recorded answers were incorrect. The available records do not establish which Mathematics topic those answers involved.',
  ]);
  assert.deepEqual([...savedByStudent.keys()], [44, 45]);
  assert.ok(cacheReadStudentIds.includes(44));
  assert.ok(cacheReadStudentIds.includes(45));
});

test('Admin, Teacher, and linked Parent reads receive the same deterministic evidence while AI is paused', async () => {
  const harness = createHarness();
  const args = {
    studentId: 44,
    gradeLevel: 'Grade 1',
    learningCycleVersion: 3,
    metrics: topicMetricsFor([0, 0, 0, 1, 1]),
    aiGenerationEnabled: false,
    pool: harness.pool,
    generateInsight: async () => { throw new Error('Paused must not call the provider.'); },
  };
  const states = await Promise.all([1, 2, 3].map((actorId) => resolveStudentAiInsight({ ...args, actorId })));

  assert.deepEqual(states.map((state) => state.status), ['paused', 'paused', 'paused']);
  assert.ok(states.every((state) => state.insight === null));
  assert.deepEqual(states[0].deterministic_evidence, states[1].deterministic_evidence);
  assert.deepEqual(states[1].deterministic_evidence, states[2].deterministic_evidence);
  assert.match(states[0].deterministic_evidence.weaknesses[0], /Subtraction — Oakleaf Bandits/);
  assert.equal(harness.calls.some(({ sql }) => sql === 'begin'), false);
  assert.equal(harness.calls.some(({ sql }) => sql.includes('insert into public.student_ai_insights')), false);
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

test('explicit Refresh AI Insight bypasses an unchanged current cache and stores the refreshed output', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const base = {
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([1, 1, 1, 0]),
    actorId: 1,
    pool: harness.pool,
  };
  const initial = await resolveStudentAiInsight({
    ...base,
    generateInsight: async () => {
      providerCalls += 1;
      return generatedInsight('Original cached analysis.');
    },
  });
  const refreshed = await resolveStudentAiInsight({
    ...base,
    forceRefresh: true,
    generateInsight: async () => {
      providerCalls += 1;
      return generatedInsight('Manually refreshed analysis.');
    },
  });
  const reused = await resolveStudentAiInsight({
    ...base,
    generateInsight: async () => {
      providerCalls += 1;
      return generatedInsight('Must remain cached.');
    },
  });

  assert.equal(initial.status, 'generated');
  assert.equal(refreshed.status, 'regenerated');
  assert.equal(refreshed.insight.performance_insight, 'Manually refreshed analysis.');
  const upsert = harness.calls.find(({ sql }) => sql.includes('insert into public.student_ai_insights'));
  assert.match(upsert.sql, /generated_at = greatest\(clock_timestamp\(\), existing\.generated_at \+ interval '1 millisecond'\)/);
  assert.equal(reused.status, 'cached');
  assert.equal(reused.insight.performance_insight, 'Manually refreshed analysis.');
  assert.equal(providerCalls, 2);
});

test('explicit refresh replaces a generic cached warning with latest canonical topic and task evidence', async () => {
  const harness = createHarness();
  const metrics = {
    ...metricsFor([1, 0, 0]),
    topicPerformance: [{
      topicId: 'addition', gradeLevel: 'Grade 1', correctAnswers: 1, totalQuestions: 3,
    }],
    topicLinkedEvidenceCount: 3,
    questTopicLinkedEvidenceCount: 3,
    unmappedQuestTopicIncorrectAnswers: 0,
    questTopicPerformance: [{
      canonicalTaskId: 'oakleaf-bandits', topicId: 'addition', gradeLevel: 'Grade 1', correctAnswers: 1, totalQuestions: 3,
    }],
  };
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics });
  harness.setSaved({
    input_fingerprint: buildInsightFingerprint(input),
    insight: {
      ...generatedInsight('Previous generic evidence warning.'),
      weaknesses: ['No verified topic was available.'],
      recommendations: ['Continue regular Math practice.'],
    },
    generated_at: '2026-09-09T00:00:00.000Z',
    stale_at: null,
  });
  let providerCalls = 0;

  const state = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics,
    forceRefresh: true,
    actorId: 1,
    pool: harness.pool,
    generateInsight: async () => {
      providerCalls += 1;
      return generatedInsight('Freshly analyzed committed results.');
    },
  });

  assert.equal(providerCalls, 1);
  assert.equal(state.status, 'regenerated');
  assert.equal(state.insight.performance_insight, 'Freshly analyzed committed results.');
  assert.match(state.insight.weaknesses[0], /Addition — Oakleaf Bandits: 2 incorrect answers were recorded/);
  assert.match(state.insight.recommendations[0], /Keep practicing Grade 1 Addition.*Oakleaf Bandits/);
  assert.equal(harness.getSaved().insight.performance_insight, 'Freshly analyzed committed results.');
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
  assert.equal(state.insight.performance_insight, before.insight.performance_insight);
  assert.match(state.insight.weaknesses[0], /General evidence.*limited evidence.*does not establish a persistent weakness or topic/);
  assert.equal(state.deterministic_evidence.topic_specific.weaknesses.length, 0);
  assert.match(state.insight.recommendations[0], /General practice: review the solutions for the 1 recorded incorrect answer/);
  assert.equal(state.insight.topic_evidence_status, 'topic_metadata_unavailable');
  assert.equal(state.topic_evidence_status, 'topic_metadata_unavailable');
  assert.deepEqual(harness.getSaved(), before);
  assert.ok(harness.calls.some(({ sql }) => sql === 'rollback'));

  const retry = await resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([1, 1, 1, 1, 0]),
    actorId: 2,
    forceRefresh: true,
    pool: harness.pool,
    generateInsight: async () => generatedInsight('A later refresh succeeded.'),
  });

  assert.equal(retry.status, 'regenerated');
  assert.equal(retry.is_stale, false);
  assert.equal(retry.insight.performance_insight, 'A later refresh succeeded.');
  assert.equal(harness.getSaved().insight.performance_insight, 'A later refresh succeeded.');
});

test('persistence failure reports a safe persistence diagnostic without changing the unavailable UX', async () => {
  const harness = createHarness({ insertError: new Error('simulated persistence failure') });
  const diagnostics = [];
  const run = resolveStudentAiInsight({
    studentId: 44,
    gradeLevel: 'Grade 1',
    metrics: metricsFor([1, 1, 1, 1, 0]),
    onInsightDiagnostics: (value) => diagnostics.push(value),
    generateInsight: async ({ onDiagnostics }) => {
      await onDiagnostics?.({
        providerHttpStatus: 200,
        responseExtractionStage: 'TOP_LEVEL_OUTPUT_TEXT',
        jsonParseSucceeded: true,
        validationStage: 'VALIDATION_PASSED',
        renderedOutputValidation: true,
        persistenceSucceeded: null,
      });
      return generatedInsight('Recorded overall accuracy is 80%.');
    },
    pool: harness.pool,
  });

  await assert.rejects(run, /simulated persistence failure/);
  assert.equal(diagnostics.at(-1).validationStage, 'PERSISTENCE_FAILED');
  assert.equal(diagnostics.at(-1).persistenceSucceeded, false);
});
