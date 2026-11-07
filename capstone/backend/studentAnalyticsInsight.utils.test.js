const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GROUNDING_POLICY_VERSION,
} = require('./studentAnalyticsGrounding.utils');
const {
  buildGroundedInsightInput,
  buildInsightFingerprint,
  buildGeneralPerformanceEvidence,
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
  topicPerformance: [
    { topicId: 'fractions', topic: 'Fractions', gradeLevel: 'Grade 3', accuracy: 60, correctAnswers: 3, incorrectAnswers: 2, totalQuestions: 5 },
    { topicId: 'multiplication', topic: 'Multiplication', gradeLevel: 'Grade 3', accuracy: 100, correctAnswers: 4, incorrectAnswers: 0, totalQuestions: 4 },
  ],
  topicLinkedEvidenceCount: 9,
  questTopicLinkedEvidenceCount: 9,
  unmappedQuestTopicIncorrectAnswers: 0,
  questTopicPerformance: [
    { canonicalTaskId: 'oakleaf-bandits', taskLabel: 'Oakleaf Bandits', topicId: 'fractions', topic: 'Fractions', gradeLevel: 'Grade 3', accuracy: 60, correctAnswers: 3, incorrectAnswers: 2, totalQuestions: 5 },
    { canonicalTaskId: 'oakleaf-bandits', taskLabel: 'Oakleaf Bandits', topicId: 'multiplication', topic: 'Multiplication', gradeLevel: 'Grade 3', accuracy: 100, correctAnswers: 4, incorrectAnswers: 0, totalQuestions: 4 },
  ],
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
  strength_claim_ids: [],
  weakness_claim_ids: ['quest_oakleaf_bandits_topic_grade_3_fractions_weakness'],
};

const inputFor = () => buildGroundedInsightInput({ gradeLevel: 'Grade 3', metrics });

test('uses only minimized deterministic facts and policy version in grounded insight input', () => {
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 3', metrics, studentId: 44, name: 'Do not include' });
  const { quest_evidence: questEvidence, ...minimizedInput } = input;

  assert.deepEqual(minimizedInput, {
    grounding_policy_version: GROUNDING_POLICY_VERSION,
    metrics_definition_version: 'student-metrics-v5',
    grade: 'Grade 3',
    learning_cycle_version: null,
    learning_cycle_started_at: null,
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
    topic_performance: [
      { topic_id: 'fractions', grade_level: 'Grade 3', correct_answers: 3, total_questions: 5 },
      { topic_id: 'multiplication', grade_level: 'Grade 3', correct_answers: 4, total_questions: 4 },
    ],
    quest_topic_performance: [
      { topic_id: 'fractions', grade_level: 'Grade 3', canonical_task_id: 'oakleaf-bandits', task_label: 'Oakleaf Bandits', correct_answers: 3, total_questions: 5 },
      { topic_id: 'multiplication', grade_level: 'Grade 3', canonical_task_id: 'oakleaf-bandits', task_label: 'Oakleaf Bandits', correct_answers: 4, total_questions: 4 },
    ],
    topic_linked_evidence_count: 9,
    quest_topic_linked_evidence_count: 9,
    unmapped_quest_topic_incorrect_answers: 0,
    unmapped_topic_incorrect_answers: 0,
    topic_evidence_status: 'weaknesses_identified',
    general_performance: {
      summary: 'Current-cycle results: 5 valid results; 3 of 5 answers were correct (60% overall); 2 were incorrect.',
      strengths: [],
      weaknesses: [],
      recommendations: [],
      map_observations: [],
      recent_trend: null,
    },
    playtime_minutes: 24,
  });
  assert.equal(questEvidence.length, 19);
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

test('invalidates the insight fingerprint when current-cycle map or recent-result evidence changes', () => {
  const quizSessions = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    score: index < 6 ? 1 : 0,
    total_items: 1,
    map_id: 'city_of_knowledge',
    played_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    result_event_id: `fingerprint-event-${index + 1}`,
  }));
  const baseline = buildGroundedInsightInput({ gradeLevel: 'Grade 3', metrics, quizSessions });
  const changedMap = buildGroundedInsightInput({
    gradeLevel: 'Grade 3', metrics,
    quizSessions: quizSessions.map((row) => ({ ...row, map_id: 'oakleaf_village' })),
  });
  const changedTrend = buildGroundedInsightInput({
    gradeLevel: 'Grade 3', metrics,
    quizSessions: quizSessions.map((row, index) => ({ ...row, score: index < 3 ? 1 : 0 })),
  });

  assert.notEqual(buildInsightFingerprint(baseline), buildInsightFingerprint(changedMap));
  assert.notEqual(buildInsightFingerprint(baseline), buildInsightFingerprint(changedTrend));
});

test('includes deterministic per-quest timing and graded evidence in the provider input and fingerprint', () => {
  const activityLogs = [
    { canonical_task_id: 'tutorial', activity_description: 'Tutorial', map_id: 'oakleaf_village', duration_seconds: 90 },
    { canonical_task_id: 'go-to-teachers-house', activity_description: 'Teacher House', map_id: 'oakleaf_village', duration_seconds: 60 },
    { canonical_task_id: 'oakleaf-bandits', activity_description: 'Bandit Challenge', map_id: 'oakleaf_village', duration_seconds: 240 },
  ];
  const quizSessions = [1, 0, 0, 1, 0].map((score, index) => ({
    canonical_task_id: 'oakleaf-bandits', score, total_items: 1,
    response_time_seconds: [8, 11, 45, 9, 52][index],
  }));
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics, activityLogs, quizSessions });
  assert.equal(input.quest_evidence.length, 19);
  assert.deepEqual(input.quest_evidence.map((quest) => quest.canonical_task_id), [
    'tutorial', 'go-to-teachers-house', 'talk-to-the-teacher', 'first-bandit-math-challenge',
    'oakleaf-bandits', 'oakleaf-boss-bandit', 'oakleaf-return-to-teacher',
    'go-to-city-of-knowledge', 'go-to-school', 'talk-to-city-school-teacher',
    'go-to-pinehill-village', 'deep-forest-bandits', 'pinehill-arrival', 'talk-to-old-man',
    'pinehill-bandits', 'defeat-the-wizard', 'return-to-city-of-knowledge',
    'return-to-city-school', 'final-teacher',
  ]);
  assert.ok(input.quest_evidence.some((row) => row.canonical_task_id === 'go-to-teachers-house'));
  assert.deepEqual(input.quest_evidence.find((row) => row.canonical_task_id === 'oakleaf-bandits'), {
    canonical_task_id: 'oakleaf-bandits', label: 'Oakleaf Bandits', map_id: 'oakleaf_village',
    map_ids: ['oakleaf_village'], location_labels: ['Oakleaf Village'], quest_type: 'mathematics_battle',
    duration_seconds: 240, correct_answers: 2, incorrect_answers: 3, total_questions: 5,
    result_count: 5, completion_date: null, last_result_at: null,
    accuracy: 40, average_response_seconds: 25,
    completion_status: 'observed', requires_graded_questions: true,
    encounter_reporting: 'task_aggregate', encounters: [], topic_performance: [],
  });
  const changed = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics, activityLogs: activityLogs.map((row) => ({ ...row, duration_seconds: row.duration_seconds + 1 })), quizSessions });
  assert.notEqual(buildInsightFingerprint(input), buildInsightFingerprint(changed));
});

test('case-variant historical task IDs group into one canonical campaign entry without changing evidence state', () => {
  const input = buildGroundedInsightInput({
    gradeLevel: 'Grade 1',
    metrics,
    activityLogs: [
      { canonical_activity_id: 'task_triggered', canonical_task_id: 'Oakleaf-Bandits' },
      { canonical_activity_id: 'task_completed', canonical_task_id: 'oakleaf-bandits' },
    ],
  });
  const matching = input.quest_evidence.filter((quest) => quest.canonical_task_id === 'oakleaf-bandits');

  assert.equal(matching.length, 1);
  assert.equal(matching[0].completion_status, 'completed');
  assert.equal(matching[0].requires_graded_questions, true);
  assert.equal(matching[0].total_questions, 0);
});

test('metrics semantics and current difficulty are fingerprinted without changing the grounding policy', () => {
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics: { ...metrics, currentDifficulty: 'Easy', totalProgressVerified: false } });
  assert.equal(input.grounding_policy_version, GROUNDING_POLICY_VERSION);
  assert.equal(input.metrics_definition_version, 'student-metrics-v5');
  assert.equal(input.current_difficulty, 'Easy');
  assert.equal(input.total_progress_verified, false);
  const legacy = { ...input };
  delete legacy.metrics_definition_version;
  assert.notEqual(buildInsightFingerprint(input), buildInsightFingerprint(legacy));
});

test('fingerprints canonical Grade-topic answer totals used for refreshed grounded insights', () => {
  const canonicalMetrics = {
    ...metrics,
    topicPerformance: [{
      topicId: 'subtraction',
      topic: 'Subtraction',
      gradeLevel: 'Grade 1',
      correctAnswers: 2,
      incorrectAnswers: 3,
      totalQuestions: 5,
      accuracy: 40,
    }],
    topicLinkedEvidenceCount: 5,
    unmappedTopicIncorrectAnswers: 0,
    questTopicPerformance: [{
      canonicalTaskId: 'oakleaf-bandits',
      topicId: 'subtraction',
      topic: 'Subtraction',
      gradeLevel: 'Grade 1',
      correctAnswers: 2,
      incorrectAnswers: 3,
      totalQuestions: 5,
      accuracy: 40,
    }],
    questTopicLinkedEvidenceCount: 5,
    unmappedQuestTopicIncorrectAnswers: 3,
  };
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics: canonicalMetrics });
  const changedTotals = buildGroundedInsightInput({
    gradeLevel: 'Grade 1',
    metrics: {
      ...canonicalMetrics,
      topicPerformance: [{ ...canonicalMetrics.topicPerformance[0], correctAnswers: 3, incorrectAnswers: 2, accuracy: 60 }],
      questTopicPerformance: [{ ...canonicalMetrics.questTopicPerformance[0], correctAnswers: 3, incorrectAnswers: 2, accuracy: 60 }],
    },
  });
  const changedGrade = buildGroundedInsightInput({
    gradeLevel: 'Grade 2',
    metrics: {
      ...canonicalMetrics,
      topicPerformance: [{ ...canonicalMetrics.topicPerformance[0], gradeLevel: 'Grade 2' }],
      questTopicPerformance: [{ ...canonicalMetrics.questTopicPerformance[0], gradeLevel: 'Grade 2' }],
    },
  });

  assert.deepEqual(input.topic_performance, [{
    topic_id: 'subtraction',
    grade_level: 'Grade 1',
    correct_answers: 2,
    total_questions: 5,
  }]);
  assert.deepEqual(input.quest_topic_performance, [{
    topic_id: 'subtraction',
    grade_level: 'Grade 1',
    canonical_task_id: 'oakleaf-bandits',
    task_label: 'Oakleaf Bandits',
    correct_answers: 2,
    total_questions: 5,
  }]);
  assert.notEqual(buildInsightFingerprint(input), buildInsightFingerprint(changedTotals));
  assert.notEqual(buildInsightFingerprint(input), buildInsightFingerprint(changedGrade));
});

test('grounds topics only for the student current Grade and fingerprints learning-cycle boundaries', () => {
  const scopedMetrics = {
    ...metrics,
    incorrectAnswers: 4,
    totalQuestions: 10,
    questTopicLinkedEvidenceCount: 5,
    unmappedQuestTopicIncorrectAnswers: 4,
    topicPerformance: [
      { topicId: 'addition', gradeLevel: 'Grade 1', correctAnswers: 1, totalQuestions: 5 },
      { topicId: 'fractions', gradeLevel: 'Grade 3', correctAnswers: 0, totalQuestions: 5 },
    ],
    questTopicPerformance: [
      { canonicalTaskId: 'oakleaf-bandits', topicId: 'addition', gradeLevel: 'Grade 1', correctAnswers: 1, totalQuestions: 5 },
      { canonicalTaskId: 'pinehill-bandits', topicId: 'fractions', gradeLevel: 'Grade 3', correctAnswers: 0, totalQuestions: 5 },
    ],
  };
  const currentCycle = buildGroundedInsightInput({
    gradeLevel: 'Grade 1',
    metrics: scopedMetrics,
    learningCycleVersion: 7,
    learningCycleStartedAt: '2026-10-01T00:00:00.000Z',
  });
  const nextCycle = buildGroundedInsightInput({
    gradeLevel: 'Grade 1',
    metrics: scopedMetrics,
    learningCycleVersion: 8,
    learningCycleStartedAt: '2026-10-13T00:00:00.000Z',
  });

  assert.deepEqual(currentCycle.topic_performance, [
    { topic_id: 'addition', grade_level: 'Grade 1', correct_answers: 1, total_questions: 5 },
  ]);
  assert.deepEqual(currentCycle.quest_topic_performance, [
    { topic_id: 'addition', grade_level: 'Grade 1', canonical_task_id: 'oakleaf-bandits', task_label: 'Oakleaf Bandits', correct_answers: 1, total_questions: 5 },
  ]);
  assert.equal(currentCycle.topic_evidence_status, 'topic_metadata_partial');
  assert.notEqual(buildInsightFingerprint(currentCycle), buildInsightFingerprint(nextCycle));
});

test('includes canonical Grade/topic evidence without requiring optional quest attribution', () => {
  const topicOnlyMetrics = {
    ...metrics,
    correctAnswers: 7,
    incorrectAnswers: 4,
    totalQuestions: 11,
    accuracy: 63.64,
    topicLinkedEvidenceCount: 11,
    questTopicLinkedEvidenceCount: 0,
    unmappedQuestTopicIncorrectAnswers: 4,
    unmappedTopicIncorrectAnswers: 0,
    topicPerformance: [
      { topicId: 'multiplication', topic: 'Multiplication', gradeLevel: 'Grade 3', correctAnswers: 5, incorrectAnswers: 0, totalQuestions: 5, accuracy: 100 },
      { topicId: 'fractions', topic: 'Fractions', gradeLevel: 'Grade 3', correctAnswers: 2, incorrectAnswers: 4, totalQuestions: 6, accuracy: 33.33 },
    ],
    questTopicPerformance: [],
  };
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 3', metrics: topicOnlyMetrics });

  assert.deepEqual(input.topic_performance, [
    { topic_id: 'fractions', grade_level: 'Grade 3', correct_answers: 2, total_questions: 6 },
    { topic_id: 'multiplication', grade_level: 'Grade 3', correct_answers: 5, total_questions: 5 },
  ]);
  assert.deepEqual(input.quest_topic_performance, []);
  assert.equal(input.topic_evidence_status, 'weaknesses_identified');
  assert.equal(input.unmapped_topic_incorrect_answers, 0);
});

test('does not mark an aggregate topic weak from an incomplete task-linked subset alone', () => {
  const input = buildGroundedInsightInput({
    gradeLevel: 'Grade 1',
    metrics: {
      validResultCount: 10,
      correctAnswers: 9,
      incorrectAnswers: 1,
      totalQuestions: 10,
      accuracy: 90,
      topicLinkedEvidenceCount: 10,
      unmappedTopicIncorrectAnswers: 0,
      questTopicLinkedEvidenceCount: 1,
      unmappedQuestTopicIncorrectAnswers: 1,
      topicPerformance: [{
        topicId: 'addition', gradeLevel: 'Grade 1', correctAnswers: 9, incorrectAnswers: 1, totalQuestions: 10,
      }],
      questTopicPerformance: [{
        canonicalTaskId: 'oakleaf-bandits', topicId: 'addition', gradeLevel: 'Grade 1',
        correctAnswers: 0, incorrectAnswers: 1, totalQuestions: 1,
      }],
    },
  });

  assert.equal(input.topic_evidence_status, 'no_supported_weakness');
});

test('deduplicates repeated committed result events in per-quest grounded evidence', () => {
  const quizSessions = [
    { canonical_task_id: 'oakleaf-bandits', result_event_id: 'same-result', score: 0, total_items: 1 },
    { canonical_task_id: 'oakleaf-bandits', result_event_id: 'same-result', score: 0, total_items: 1 },
    { canonical_task_id: 'oakleaf-bandits', result_event_id: 'different-result', score: 1, total_items: 1 },
  ];
  const quest = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics, quizSessions })
    .quest_evidence.find((row) => row.canonical_task_id === 'oakleaf-bandits');
  assert.equal(quest.total_questions, 2);
  assert.equal(quest.correct_answers, 1);
  assert.equal(quest.incorrect_answers, 1);
});

test('keeps completed and started non-graded tasks distinct from missing graded evidence', () => {
  const input = buildGroundedInsightInput({
    gradeLevel: 'Grade 1',
    metrics,
    activityLogs: [
      {
        canonical_activity_id: 'task_completed',
        canonical_task_id: 'go-to-school',
        current_quest: 'Go to the School.',
        map_id: 'city_of_knowledge',
      },
      {
        canonical_activity_id: 'task_triggered',
        canonical_task_id: 'talk-to-city-school-teacher',
        current_quest: 'Talk to the Teacher.',
        map_id: 'city_of_knowledge',
      },
      {
        canonical_activity_id: 'task_completed',
        canonical_task_id: 'oakleaf-bandits',
        current_quest: 'Defeat the Oakleaf Bandits.',
        map_id: 'oakleaf_village',
      },
    ],
  });

  const byTask = new Map(input.quest_evidence.map((quest) => [quest.canonical_task_id, quest]));
  assert.equal(input.quest_evidence.length, 19);
  assert.equal(byTask.get('go-to-school').completion_status, 'completed');
  assert.equal(byTask.get('go-to-school').requires_graded_questions, false);
  assert.equal(byTask.get('oakleaf-bandits').completion_status, 'completed');
  assert.equal(byTask.get('oakleaf-bandits').requires_graded_questions, true);
  assert.equal(byTask.get('talk-to-city-school-teacher').completion_status, 'started');
  assert.equal(byTask.get('talk-to-city-school-teacher').requires_graded_questions, false);
});

test('includes canonical quests with no observations and uses canonical labels and types', () => {
  const input = buildGroundedInsightInput({
    gradeLevel: 'Grade 1',
    metrics: { ...metrics, validResultCount: 0, correctAnswers: 0, incorrectAnswers: 0, totalQuestions: 0 },
  });
  const byTask = new Map(input.quest_evidence.map((quest) => [quest.canonical_task_id, quest]));

  assert.equal(input.quest_evidence.length, 19); // Tutorial plus the 18 player-facing graph tasks.
  assert.equal(byTask.get('go-to-teachers-house').quest_type, 'exploration');
  assert.equal(byTask.get('go-to-teachers-house').completion_status, 'not_recorded');
  assert.equal(byTask.get('go-to-teachers-house').requires_graded_questions, false);
  assert.equal(byTask.get('pinehill-bandits').quest_type, 'mathematics_battle');
  assert.equal(byTask.get('defeat-the-wizard').quest_type, 'boss_battle');
  assert.equal(byTask.get('go-to-pinehill-village').quest_type, 'map_transition');
});

test('uses current-cycle completion milestones and never lets freeform labels or map IDs replace canonical facts', () => {
  const input = buildGroundedInsightInput({
    gradeLevel: 'Grade 1',
    metrics,
    activityLogs: [{
      canonical_activity_id: 'task_completed',
      canonical_task_id: 'go-to-teachers-house',
      current_quest: 'Freeform Deepest Forest Path text',
      map_id: 'unrecognized-freeform-map',
      completed_at: '2026-10-30T12:00:00.000Z',
    }],
    completedMilestones: [{
      canonical_task_id: 'oakleaf-bandits', player_facing: true,
      quest_graph_version: 'oakleaf-city-pinehill-v1', completed_at: '2026-10-30T12:05:00.000Z',
    }, {
      canonical_task_id: 'pinehill-bandits', player_facing: false,
      quest_graph_version: 'oakleaf-city-pinehill-v1', completed_at: '2026-10-30T12:06:00.000Z',
    }],
  });
  const byTask = new Map(input.quest_evidence.map((quest) => [quest.canonical_task_id, quest]));

  assert.equal(byTask.get('go-to-teachers-house').label, "Go to the Teacher's House");
  assert.equal(byTask.get('go-to-teachers-house').map_id, null);
  assert.equal(byTask.get('go-to-teachers-house').completion_status, 'completed');
  assert.equal(byTask.get('go-to-teachers-house').completion_date, '2026-10-30T12:00:00.000Z');
  assert.equal(byTask.get('oakleaf-bandits').completion_status, 'completed');
  assert.equal(byTask.get('oakleaf-bandits').completion_date, '2026-10-30T12:05:00.000Z');
  assert.equal(byTask.get('pinehill-bandits').completion_status, 'not_recorded');
});

test('maps saved Pinehill Guard IDs to recorded encounters and aggregates only supported battle results', () => {
  const quizSessions = [
    {
      canonical_task_id: 'pinehill-bandits', canonical_battle_id: 'pinehill_bandits2',
      quest_graph_version: 'oakleaf-city-pinehill-v1', map_id: 'pinehill_village',
      score: 1, total_items: 1, result_event_id: 'guard-two-answer', played_at: '2026-10-30T12:08:00.000Z',
      question_set_id: 92, canonical_topic_id: 'addition', canonical_grade_level: 'Grade 1',
      canonical_difficulty: 'Normal', question_topic_ids: [], question_math_topics: [],
    },
    {
      canonical_task_id: 'pinehill-bandits', canonical_battle_id: 'pinehill_bandits4',
      quest_graph_version: 'oakleaf-city-pinehill-v1', map_id: 'pinehill_village',
      score: 0, total_items: 1, result_event_id: 'guard-four-answer', played_at: '2026-10-30T12:09:00.000Z',
      question_set_id: 92, canonical_topic_id: 'addition', canonical_grade_level: 'Grade 1',
      canonical_difficulty: 'Normal', question_topic_ids: [], question_math_topics: [],
    },
  ];
  const quest = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics, quizSessions })
    .quest_evidence.find((row) => row.canonical_task_id === 'pinehill-bandits');

  assert.deepEqual(quest.encounters, [
    { id: 'pinehill_bandits2', label: 'Guard 2' },
    { id: 'pinehill_bandits4', label: 'Guard 4' },
  ]);
  assert.equal(quest.encounter_reporting, 'individual_recorded_encounters');
  assert.deepEqual(quest.location_labels, ['Pinehill Village']);
  assert.equal(quest.correct_answers, 1);
  assert.equal(quest.incorrect_answers, 1);
  assert.equal(quest.total_questions, 2);
  assert.equal(quest.accuracy, 50);
  assert.deepEqual(quest.topic_performance, [{
    topic_id: 'addition', topic: 'Addition', grade_level: 'Grade 1',
    correct_answers: 1, incorrect_answers: 1, total_questions: 2, accuracy: 50,
  }]);
  assert.equal(quest.last_result_at, '2026-10-30T12:09:00.000Z');
  assert.equal(quest.completion_status, 'observed');
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
  assert.deepEqual(insight.strengths, []); // Four answers cannot establish a Math strength.
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
    ['provider recommendation selection removed', { output_text: JSON.stringify({ ...valid, recommendation_claim_ids: ['practice_difficulty_normal'] }) }, 'RESPONSE_SHAPE_INVALID'],
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
    'strength_claim_ids',
    'weakness_claim_ids',
  ]);
  assert.equal(diagnostics.claimCounts.recommendations, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'rawResponse'), false);
  assert.equal(JSON.stringify(diagnostics).includes('Recorded overall accuracy'), false);
  assert.match(result.performance_insight, /Recorded overall accuracy/);
});

test('records safe Responses envelope metadata without retaining response content', async () => {
  const { diagnostics, result } = await diagnosticsFor({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens', code: 'output_limit' },
    output: [
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(validSelection) }] },
      { type: 'reasoning', content: [{ type: 'refusal', refusal: 'private provider content' }] },
    ],
  }, { expectSuccess: true });

  assert.equal(diagnostics.responseStatus, 'incomplete');
  assert.equal(diagnostics.incompleteReason, 'max_output_tokens');
  assert.equal(diagnostics.incompleteCode, 'output_limit');
  assert.deepEqual(diagnostics.outputItemTypes, ['message', 'reasoning']);
  assert.deepEqual(diagnostics.contentItemTypes, ['output_text', 'refusal']);
  assert.equal(diagnostics.refusalContentPresent, true);
  assert.equal(JSON.stringify(diagnostics).includes('private provider content'), false);
  assert.match(result.performance_insight, /Recorded overall accuracy/);
});

test('builds general evidence from current-cycle aggregate counts without inventing a topic', () => {
  const evidence = buildGeneralPerformanceEvidence({
    metrics: {
      validResultCount: 63,
      correctAnswers: 53,
      incorrectAnswers: 10,
      totalQuestions: 63,
      accuracy: 84.13,
      topicLinkedEvidenceCount: 0,
      unmappedTopicIncorrectAnswers: 10,
    },
  });

  assert.equal(evidence.summary, 'Current-cycle results: 63 valid results; 53 of 63 answers were correct (84.1% overall); 10 were incorrect.');
  assert.deepEqual(evidence.strengths, [
    'General evidence (overall performance, not a specific Mathematics topic): 53 of 63 recorded answers were correct (84.1%).',
  ]);
  assert.deepEqual(evidence.weaknesses, [
    'General evidence (not topic-specific): 10 of 63 recorded answers were incorrect. The available records do not establish which Mathematics topic those answers involved.',
  ]);
  assert.deepEqual(evidence.recommendations, [
    'General practice: review the solutions for the 10 recorded incorrect answers and practice similar Mathematics problems. This is not a topic-specific recommendation.',
  ]);
  assert.deepEqual(evidence.map_observations, []);
  assert.equal(evidence.recent_trend, null);
  assert.equal(JSON.stringify(evidence).includes('Subtraction'), false);
});

test('includes only recognized current-cycle map summaries and a recent trend with ten valid timestamped results', () => {
  const quizSessions = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    score: index < 5 ? (index < 4 ? 1 : 0) : (index < 7 ? 1 : 0),
    total_items: 1,
    map_id: 'city_of_knowledge',
    played_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    result_event_id: `event-${index + 1}`,
  }));
  quizSessions.push({
    id: 11, score: 1, total_items: 1, map_id: 'not-a-canonical-map',
    current_map: 'Mathematics Forest',
  });
  const evidence = buildGeneralPerformanceEvidence({
    metrics: {
      validResultCount: 10,
      correctAnswers: 6,
      incorrectAnswers: 4,
      totalQuestions: 10,
      topicLinkedEvidenceCount: 0,
      unmappedTopicIncorrectAnswers: 4,
    },
    quizSessions,
  });

  assert.deepEqual(evidence.map_observations, [
    { map_name: 'City of Knowledge', correct_answers: 6, incorrect_answers: 4, total_questions: 10, accuracy: 60 },
  ]);
  assert.deepEqual(evidence.recent_trend, {
    recent_result_count: 5,
    previous_result_count: 5,
    recent_accuracy: 40,
    previous_accuracy: 80,
    difference_points: -40,
  });
  assert.equal(evidence.summary, 'Current-cycle results: 10 valid results; 6 of 10 answers were correct (60% overall); 4 were incorrect.');
  assert.doesNotMatch(JSON.stringify(evidence), /Mathematics Forest/);
});

test('does not call a small perfect sample a general strength or a weakness', () => {
  const evidence = buildGeneralPerformanceEvidence({
    metrics: {
      validResultCount: 4,
      correctAnswers: 4,
      incorrectAnswers: 0,
      totalQuestions: 4,
      topicLinkedEvidenceCount: 0,
      unmappedTopicIncorrectAnswers: 0,
    },
  });

  assert.deepEqual(evidence.strengths, []);
  assert.deepEqual(evidence.weaknesses, []);
  assert.deepEqual(evidence.recommendations, []);
  assert.match(evidence.summary, /4 of 4 answers were correct/);
});

test('uses five attempts and 80 percent accuracy for a general Strength', () => {
  const evidence = buildGeneralPerformanceEvidence({
    metrics: {
      validResultCount: 5,
      correctAnswers: 4,
      incorrectAnswers: 1,
      totalQuestions: 5,
      topicLinkedEvidenceCount: 0,
      unmappedTopicIncorrectAnswers: 1,
    },
  });

  assert.deepEqual(evidence.strengths, [
    'General evidence (overall performance, not a specific Mathematics topic): 4 of 5 recorded answers were correct (80%).',
  ]);
  assert.equal(evidence.weaknesses.length, 1);
  assert.match(evidence.weaknesses[0], /limited evidence/);
});
