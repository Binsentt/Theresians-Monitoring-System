const GROUNDING_POLICY_VERSION = 'grounded-claims-v7';
const WEAK_PERFORMANCE_THRESHOLD = 75;
const STRENGTH_MIN_ATTEMPTS = 5;
const STRENGTH_MIN_ACCURACY = 80;
const MAX_SELECTION_ITEMS = 5;
const MAX_TOPIC_LABEL_LENGTH = 80;
const MAX_RENDERED_PERFORMANCE_LENGTH = 900;
const { SCOPES, getTopicById, normalizeGradeLevel, normalizeTopicId } = require('./curriculumScopeRegistry');
const { canonicalTaskDisplayLabel, PLAYER_FACING_TASKS } = require('./questGraph.utils');

const INSIGHT_VALIDATION_STAGES = Object.freeze({
  RESPONSE_SHAPE_INVALID: 'RESPONSE_SHAPE_INVALID',
  POLICY_VERSION_INVALID: 'POLICY_VERSION_INVALID',
  CLAIM_ID_UNKNOWN: 'CLAIM_ID_UNKNOWN',
  CLAIM_ID_DUPLICATE: 'CLAIM_ID_DUPLICATE',
  CLAIM_SUPPORT_INVALID: 'CLAIM_SUPPORT_INVALID',
  RENDERED_OUTPUT_INVALID: 'RENDERED_OUTPUT_INVALID',
  VALIDATION_PASSED: 'VALIDATION_PASSED',
});

const DIFFICULTY_CONFIG = [
  { key: 'easy', id: 'easy', label: 'Easy' },
  { key: 'medium', id: 'normal', label: 'Normal' },
  { key: 'hard', id: 'difficult', label: 'Difficult' },
];

class GroundingValidationError extends Error {
  constructor(message, stage = INSIGHT_VALIDATION_STAGES.RESPONSE_SHAPE_INVALID, details = {}) {
    super(message);
    this.name = 'GroundingValidationError';
    this.code = 'ANALYTICS_AI_GROUNDING_FAILED';
    this.stage = stage;
    this.details = Object.freeze({ ...details });
  }
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

const formatNumber = (value) => {
  if (!isFiniteNumber(value)) throw new GroundingValidationError('Grounding evidence contains an invalid number.');
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
};

const formatPercentage = (value) => `${formatNumber(value)}%`;

const asSafeQuestLabel = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TOPIC_LABEL_LENGTH || /[\r\n\t]/.test(normalized)) return null;
  return normalized;
};

const createCatalog = (input) => ({
  policyVersion: GROUNDING_POLICY_VERSION,
  providerEvidence: input,
  topicEvidenceStatus: 'no_topic_evidence',
  performance: [],
  strength: [],
  weakness: [],
  recommendation: [],
});

const addClaim = (catalog, category, claim) => {
  if (catalog[category].some((entry) => entry.id === claim.id)) {
    throw new GroundingValidationError(`Grounding catalog contains duplicate ${category} claim ${claim.id}.`);
  }
  catalog[category].push(Object.freeze({ ...claim }));
};

const addPerformanceClaim = (catalog, id, text) => addClaim(catalog, 'performance', { id, text });

function addRecordedPerformanceClaims(catalog, input) {
  if (isNonNegativeInteger(input.results_recorded)) {
    addPerformanceClaim(catalog, 'results_recorded', `${input.results_recorded} valid gameplay results are recorded.`);
  }
  if (isNonNegativeInteger(input.correct_answers) && isNonNegativeInteger(input.incorrect_answers)) {
    addPerformanceClaim(catalog, 'answer_counts', `Recorded answers: ${input.correct_answers} correct answers and ${input.incorrect_answers} incorrect answers.`);
  }
  if (isFiniteNumber(input.accuracy)) {
    addPerformanceClaim(catalog, 'overall_accuracy', `Recorded overall accuracy is ${formatPercentage(input.accuracy)}.`);
  }
  if (isFiniteNumber(input.game_score)) {
    addPerformanceClaim(catalog, 'game_score', `Recorded game score is ${formatNumber(input.game_score)}.`);
  }
  if (input.total_progress_verified === true && isFiniteNumber(input.total_progress)) {
    addPerformanceClaim(catalog, 'total_progress', `Recorded total progress is ${formatPercentage(input.total_progress)}.`);
  }
  if (isNonNegativeInteger(input.completed_quests)) {
    addPerformanceClaim(catalog, 'completed_quests', `Recorded completed quests: ${input.completed_quests}.`);
  }
  const currentQuest = asSafeQuestLabel(input.current_quest);
  if (currentQuest) addPerformanceClaim(catalog, 'current_quest', `Current quest: ${currentQuest}.`);
  if (['Easy', 'Normal', 'Difficult'].includes(input.current_difficulty)) {
    addPerformanceClaim(catalog, 'current_difficulty', `Current gameplay difficulty is ${input.current_difficulty}.`);
  }
  if (isFiniteNumber(input.playtime_minutes)) {
    addPerformanceClaim(catalog, 'playtime_minutes', `Recorded completed playtime is ${formatNumber(input.playtime_minutes)} minutes.`);
  }
}

function addDifficultyClaims(catalog, difficultyAccuracy) {
  const values = difficultyAccuracy && typeof difficultyAccuracy === 'object' ? difficultyAccuracy : {};
  DIFFICULTY_CONFIG.forEach(({ key, id, label }) => {
    const accuracy = values[key];
    if (accuracy === null) {
      const noDataId = `difficulty_${id}_no_data`;
      addPerformanceClaim(catalog, noDataId, `No recorded ${label} performance data is available yet.`);
      return;
    }
    if (isFiniteNumber(accuracy)) {
      addPerformanceClaim(catalog, `difficulty_${id}_accuracy`, `Recorded ${label} accuracy is ${formatPercentage(accuracy)}.`);
    }
  });
}

function addObservedTopicClaims(catalog, topicPerformance, questTopicPerformance, input) {
  const studentGrade = normalizeGradeLevel(input.grade);
  const normalizeEvidence = (topic, { requireTask = false } = {}) => {
    const topicId = normalizeTopicId(topic?.topic_id);
    const gradeLevel = normalizeGradeLevel(topic?.grade_level);
    const canonicalTopic = topicId ? getTopicById(topicId) : null;
    const belongsToGrade = Boolean(gradeLevel && topicId && SCOPES.some((scope) => (
      scope.grade_level === gradeLevel && scope.topic_ids.includes(topicId)
    )));
    const correct = topic?.correct_answers;
    const total = topic?.total_questions;
    const canonicalTaskId = String(topic?.canonical_task_id || '').trim().toLowerCase();
    const taskLabel = PLAYER_FACING_TASKS.includes(canonicalTaskId)
      ? canonicalTaskDisplayLabel(canonicalTaskId) : null;
    if (!canonicalTopic || !belongsToGrade || !isNonNegativeInteger(correct)
      || !isNonNegativeInteger(total) || total < 1 || correct > total
      || (studentGrade && gradeLevel !== studentGrade)
      || (requireTask && !taskLabel)) return null;
    return {
      topicId,
      gradeLevel,
      canonicalTopic,
      canonicalTaskId: taskLabel ? canonicalTaskId : null,
      taskLabel,
      correct,
      total,
      incorrect: total - correct,
      accuracy: Number(((correct / total) * 100).toFixed(2)),
    };
  };

  const validatedTopicRows = (Array.isArray(topicPerformance) ? topicPerformance : [])
    .map((topic) => normalizeEvidence(topic))
    .filter(Boolean);
  const topicTotals = new Map();
  validatedTopicRows.forEach((row) => {
    const key = `${row.gradeLevel}|${row.topicId}`;
    const current = topicTotals.get(key) || { ...row, correct: 0, total: 0 };
    current.correct += row.correct;
    current.total += row.total;
    topicTotals.set(key, current);
  });

  // Older callers supplied task-linked rows in topic_performance. The v5
  // contract separates task evidence, so use that legacy shape only when the
  // dedicated quest array is absent; never add both arrays together.
  const rawQuestRows = Array.isArray(questTopicPerformance)
    ? questTopicPerformance
    : validatedTopicRows.filter((row) => row.canonicalTaskId).map((row) => ({
      topic_id: row.topicId,
      grade_level: row.gradeLevel,
      canonical_task_id: row.canonicalTaskId,
      correct_answers: row.correct,
      total_questions: row.total,
    }));
  const validatedQuestRows = rawQuestRows
    .map((topic) => normalizeEvidence(topic, { requireTask: true }))
    .filter(Boolean);
  const questTotals = new Map();
  validatedQuestRows.forEach((row) => {
    const key = `${row.gradeLevel}|${row.topicId}|${row.canonicalTaskId}`;
    const current = questTotals.get(key) || { ...row, correct: 0, total: 0 };
    current.correct += row.correct;
    current.total += row.total;
    questTotals.set(key, current);
  });
  const questsByTopic = new Map();
  questTotals.forEach((row) => {
    const key = `${row.gradeLevel}|${row.topicId}`;
    questsByTopic.set(key, [...(questsByTopic.get(key) || []), row]);
  });

  const topics = [...topicTotals.values()]
    .map((row) => ({
      ...row,
      incorrect: row.total - row.correct,
      accuracy: Number(((row.correct / row.total) * 100).toFixed(2)),
    }))
    .sort((left, right) => left.accuracy - right.accuracy
      || right.incorrect - left.incorrect
      || right.total - left.total
      || left.gradeLevel.localeCompare(right.gradeLevel)
      || left.topicId.localeCompare(right.topicId));

  topics.forEach(({ topicId, gradeLevel, canonicalTopic, correct, total, accuracy }) => {
    if (total < STRENGTH_MIN_ATTEMPTS || accuracy < STRENGTH_MIN_ACCURACY) return;
    addClaim(catalog, 'strength', {
      id: `topic_${gradeLevel.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${topicId}_strength`,
      text: `Strong performance in ${canonicalTopic.display_label}: ${correct} of ${total} recorded answers correct (${formatPercentage(accuracy)}).`,
    });
  });

  let supportedWeaknesses = 0;
  topics.forEach(({ topicId, gradeLevel, canonicalTopic, correct, total, incorrect, accuracy }) => {
    const topicKey = `${gradeLevel}|${topicId}`;
    const matchingQuestRows = questsByTopic.get(topicKey) || [];
    const questTotalsMatchTopic = matchingQuestRows.length > 0
      && matchingQuestRows.reduce((sum, row) => sum + row.correct, 0) === correct
      && matchingQuestRows.reduce((sum, row) => sum + row.total, 0) === total;
    const claimRows = questTotalsMatchTopic
      ? matchingQuestRows
      : [{ topicId, gradeLevel, canonicalTopic, correct, total, incorrect, accuracy }];
    const gradeKey = gradeLevel.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    claimRows.forEach((row) => {
      const taskLabel = questTotalsMatchTopic ? row.taskLabel : null;
      const contextLabel = taskLabel ? `${canonicalTopic.display_label} — ${taskLabel}` : canonicalTopic.display_label;
      const claimPrefix = taskLabel
        ? `quest_${row.canonicalTaskId.replace(/[^a-z0-9]+/g, '_')}_topic_${gradeKey}_${topicId}`
        : `topic_${gradeKey}_${topicId}`;
      const rowIncorrect = row.total - row.correct;
      const rowAccuracy = Number(((row.correct / row.total) * 100).toFixed(2));
      const accuracyText = formatPercentage(rowAccuracy);
      addPerformanceClaim(
        catalog,
        `${claimPrefix}_accuracy`,
        `Recorded ${contextLabel} accuracy is ${accuracyText} (${row.correct} of ${row.total} answers correct; ${rowIncorrect} incorrect).`
      );

      if (rowAccuracy >= WEAK_PERFORMANCE_THRESHOLD || rowIncorrect <= 0) return;

      supportedWeaknesses += 1;
      const limited = rowIncorrect <= 3;
      addClaim(catalog, 'weakness', {
        id: `${claimPrefix}_weakness`,
        text: limited
          ? `${contextLabel}: ${rowIncorrect} incorrect ${rowIncorrect === 1 ? 'answer was' : 'answers were'} recorded (${row.correct} of ${row.total} correct; ${accuracyText} accuracy). This is limited evidence and does not yet show a persistent weakness.`
          : `${contextLabel}: ${rowIncorrect} of ${row.total} answers were incorrect (${accuracyText} accuracy). This is below the current ${WEAK_PERFORMANCE_THRESHOLD}% evidence boundary.`,
      });
      const gradeNumber = gradeLevel.replace(/^Grade\s+/i, '');
      addClaim(catalog, 'recommendation', {
        id: `practice_${claimPrefix}`,
        supportId: `${claimPrefix}_weakness`,
        supportCategory: 'weakness',
        text: limited
          ? `Keep practicing Grade ${gradeNumber} ${canonicalTopic.display_label} and review the ${rowIncorrect} missed ${rowIncorrect === 1 ? 'question' : 'questions'}${taskLabel ? ` from ${taskLabel}` : ''}. More recorded answers are needed before judging a persistent weakness.`
          : `Practice Grade ${gradeNumber} ${canonicalTopic.display_label}${taskLabel ? `, especially the types missed during ${taskLabel}` : ''}. Review the ${rowIncorrect} recorded incorrect ${rowIncorrect === 1 ? 'answer' : 'answers'} before retrying similar questions (${row.correct} of ${row.total} correct; ${accuracyText} accuracy).`,
      });
    });
  });

  const validTopics = topics.length;
  if (supportedWeaknesses === 0 && validTopics === 0
    && isNonNegativeInteger(input.incorrect_answers)
    && input.incorrect_answers >= 1 && input.incorrect_answers <= 3) {
    const incorrect = input.incorrect_answers;
    addClaim(catalog, 'weakness', {
      id: 'unlinked_limited_errors',
      text: `${incorrect} incorrect ${incorrect === 1 ? 'answer was' : 'answers were'} recorded. This is limited evidence and does not identify a persistent Math weakness or a verified topic.`,
    });
    addClaim(catalog, 'recommendation', {
      id: 'review_unlinked_limited_errors',
      supportId: 'unlinked_limited_errors',
      supportCategory: 'weakness',
      text: `Review the ${incorrect} missed ${incorrect === 1 ? 'question' : 'questions'} and continue regular Math practice. More topic-linked results are needed for a specific recommendation.`,
    });
  }

  const hasRecordedPerfectResults = isNonNegativeInteger(input.total_questions)
    && input.total_questions > 0
    && input.incorrect_answers === 0;
  const hasTopicMetadataGap = isNonNegativeInteger(input.incorrect_answers)
    && input.incorrect_answers > 0
    && (validTopics === 0
      || (isNonNegativeInteger(input.unmapped_topic_incorrect_answers) && input.unmapped_topic_incorrect_answers > 0)
      || (isNonNegativeInteger(input.topic_linked_evidence_count)
        && input.topic_linked_evidence_count < input.total_questions));
  if (hasTopicMetadataGap) {
    addPerformanceClaim(
      catalog,
      'topic_evidence_unavailable',
      validTopics === 0
        ? 'Incorrect answers are recorded, but no validated Grade/topic-linked question evidence is available to identify the specific Math topic.'
        : 'Some incorrect answers are recorded without validated Grade/topic metadata; only linked answers are used for topic-level claims.'
    );
  }
  catalog.topicEvidenceStatus = hasRecordedPerfectResults
    ? 'perfect_recorded_results'
    : hasTopicMetadataGap
      ? (validTopics > 0 ? 'topic_metadata_partial' : 'topic_metadata_unavailable')
      : supportedWeaknesses > 0
        ? 'weaknesses_identified'
        : validTopics > 0
          ? 'no_supported_weakness'
          : 'no_topic_evidence';
}

function freezeCatalog(catalog) {
  const freezeEntries = (entries) => Object.freeze(entries.slice());
  const frozen = {
    policyVersion: catalog.policyVersion,
    topicEvidenceStatus: catalog.topicEvidenceStatus,
    providerEvidence: Object.freeze({ ...catalog.providerEvidence }),
    performance: freezeEntries(catalog.performance),
    strength: freezeEntries(catalog.strength),
    weakness: freezeEntries(catalog.weakness),
    recommendation: freezeEntries(catalog.recommendation),
  };
  frozen.permittedClaimIds = Object.freeze({
    performance: Object.freeze(frozen.performance.map((entry) => entry.id)),
    strength: Object.freeze(frozen.strength.map((entry) => entry.id)),
    weakness: Object.freeze(frozen.weakness.map((entry) => entry.id)),
    recommendation: Object.freeze(frozen.recommendation.map((entry) => entry.id)),
  });
  return Object.freeze(frozen);
}

function buildGroundedClaimCatalog(input = {}) {
  if (input.grounding_policy_version !== GROUNDING_POLICY_VERSION) {
    throw new GroundingValidationError(
      'Grounding input policy version is invalid.',
      INSIGHT_VALIDATION_STAGES.POLICY_VERSION_INVALID
    );
  }
  const catalog = createCatalog(input);
  addRecordedPerformanceClaims(catalog, input);
  addDifficultyClaims(catalog, input.difficulty_accuracy);
  addObservedTopicClaims(catalog, input.topic_performance, input.quest_topic_performance, input);
  return freezeCatalog(catalog);
}

const arraySchemaFor = (ids, minItems = 0) => (ids.length === 0
  ? { type: 'array', minItems: 0, maxItems: 0, items: { type: 'string' } }
  : {
    type: 'array',
    minItems,
    maxItems: Math.min(MAX_SELECTION_ITEMS, ids.length),
    items: { type: 'string', enum: ids },
  });

function buildClaimSelectionSchema(catalog) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'grounding_policy_version',
      'performance_claim_ids',
      'strength_claim_ids',
      'weakness_claim_ids',
    ],
    properties: {
      grounding_policy_version: { type: 'string', enum: [catalog.policyVersion] },
      performance_claim_ids: arraySchemaFor(catalog.permittedClaimIds.performance, 1),
      strength_claim_ids: arraySchemaFor(catalog.permittedClaimIds.strength),
      weakness_claim_ids: arraySchemaFor(
        catalog.permittedClaimIds.weakness
      ),
    },
  };
}

const selectionKeys = [
  'grounding_policy_version',
  'performance_claim_ids',
  'strength_claim_ids',
  'weakness_claim_ids',
];

const categoryForSelectionKey = {
  performance_claim_ids: 'performance',
  strength_claim_ids: 'strength',
  weakness_claim_ids: 'weakness',
};

const findClaim = (catalog, category, id) => catalog[category].find((entry) => entry.id === id) || null;

function normalizeSelectionGroups(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new GroundingValidationError(
      'Grounding claim selection must be an object.',
      INSIGHT_VALIDATION_STAGES.RESPONSE_SHAPE_INVALID
    );
  }
  const unexpectedKeys = Object.keys(selection).filter((key) => !selectionKeys.includes(key));
  if (unexpectedKeys.length > 0) {
    throw new GroundingValidationError(
      'Grounding claim selection contains unsupported properties.',
      INSIGHT_VALIDATION_STAGES.RESPONSE_SHAPE_INVALID
    );
  }
  const groups = {};
  Object.keys(categoryForSelectionKey).forEach((key) => {
    const value = selection[key];
    if (!Array.isArray(value) || value.length > MAX_SELECTION_ITEMS || value.some((id) => typeof id !== 'string' || !id)) {
      throw new GroundingValidationError(
        `Grounding ${key} is invalid.`,
        INSIGHT_VALIDATION_STAGES.RESPONSE_SHAPE_INVALID
      );
    }
    groups[key] = value.slice();
  });
  if (groups.performance_claim_ids.length === 0) {
    throw new GroundingValidationError(
      'Grounding performance claims are required.',
      INSIGHT_VALIDATION_STAGES.RESPONSE_SHAPE_INVALID
    );
  }
  return groups;
}

function validateClaimSelection(selection, catalog) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new GroundingValidationError(
      'Grounding claim selection must be an object.',
      INSIGHT_VALIDATION_STAGES.RESPONSE_SHAPE_INVALID
    );
  }
  if (!catalog || catalog.policyVersion !== GROUNDING_POLICY_VERSION) {
    throw new GroundingValidationError(
      'Grounding catalog policy is invalid.',
      INSIGHT_VALIDATION_STAGES.POLICY_VERSION_INVALID
    );
  }
  if (selection?.grounding_policy_version !== catalog.policyVersion) {
    throw new GroundingValidationError(
      'Grounding policy version does not match the evidence catalog.',
      INSIGHT_VALIDATION_STAGES.POLICY_VERSION_INVALID
    );
  }
  const groups = normalizeSelectionGroups(selection);
  const selectedIds = new Set();
  Object.entries(categoryForSelectionKey).forEach(([key, category]) => {
    groups[key].forEach((id) => {
      if (selectedIds.has(id)) {
        throw new GroundingValidationError(
          'Grounding claim selection contains duplicate claim IDs.',
          INSIGHT_VALIDATION_STAGES.CLAIM_ID_DUPLICATE,
          { duplicateClaimCount: 1 }
        );
      }
      selectedIds.add(id);
      if (!findClaim(catalog, category, id)) {
        const knownInAnotherCategory = ['performance', 'strength', 'weakness', 'recommendation']
          .some((candidateCategory) => candidateCategory !== category && findClaim(catalog, candidateCategory, id));
        throw new GroundingValidationError(
          `Grounding ${category} claim is unsupported: ${id}.`,
          INSIGHT_VALIDATION_STAGES.CLAIM_ID_UNKNOWN,
          {
            unknownClaimCount: knownInAnotherCategory ? 0 : 1,
            unsupportedClaimCount: 1,
          }
        );
      }
    });
  });

  return Object.freeze({
    grounding_policy_version: catalog.policyVersion,
    ...groups,
  });
}

function deriveSupportedRecommendationIds(selection, catalog) {
  const selectedByCategory = {
    performance: new Set(selection.performance_claim_ids),
    weakness: new Set(selection.weakness_claim_ids),
  };
  const seen = new Set();
  return catalog.recommendation
    .filter((claim) => {
      const selectedClaims = selectedByCategory[claim.supportCategory];
      if (!selectedClaims || !selectedClaims.has(claim.supportId) || seen.has(claim.id)) return false;
      seen.add(claim.id);
      return true;
    })
    .map((claim) => claim.id);
}

function renderGroup(ids, catalog, category, separator = '\n') {
  const text = ids.map((id) => findClaim(catalog, category, id).text);
  return category === 'performance' ? text.join(separator) : text;
}

function renderQuestInsights(questEvidence = []) {
  return (Array.isArray(questEvidence) ? questEvidence : []).map((quest) => {
    const facts = [];
    if (isFiniteNumber(quest.duration_seconds)) facts.push(`recorded duration ${formatNumber(quest.duration_seconds)} seconds`);
    if (isNonNegativeInteger(quest.total_questions) && quest.total_questions > 0
      && isNonNegativeInteger(quest.correct_answers) && isNonNegativeInteger(quest.incorrect_answers)
      && isFiniteNumber(quest.accuracy)) {
      facts.push(`${quest.correct_answers} correct and ${quest.incorrect_answers} incorrect (${formatPercentage(quest.accuracy)})`);
    }
    if (isFiniteNumber(quest.average_response_seconds)) facts.push(`average recorded response time ${formatNumber(quest.average_response_seconds)} seconds`);
    const completionStatus = String(quest.completion_status || '').trim().toLowerCase();
    const requiresGradedQuestions = quest.requires_graded_questions === true;
    const lifecycleSummary = completionStatus === 'completed'
      ? (requiresGradedQuestions
        ? 'Quest completed; no graded question result is recorded for this task yet.'
        : 'Quest completed — no graded questions required.')
      : completionStatus === 'started'
        ? (requiresGradedQuestions
          ? 'Quest started; no graded question result is recorded for this task yet.'
          : 'Quest started — no graded questions required.')
        : completionStatus === 'observed'
          ? (requiresGradedQuestions
            ? 'Canonical quest activity is recorded, but no graded question result is recorded for this task yet.'
            : 'Canonical quest activity is recorded, but completion is not confirmed and no graded questions are required.')
          : (requiresGradedQuestions
            ? 'No canonical completion or graded question evidence is recorded for this task yet.'
            : 'No canonical completion evidence is recorded for this non-graded quest yet.');
    return {
      canonical_task_id: asSafeQuestLabel(quest.canonical_task_id),
      label: asSafeQuestLabel(quest.label) || asSafeQuestLabel(quest.canonical_task_id),
      map_id: asSafeQuestLabel(quest.map_id),
      completion_status: completionStatus || 'unknown',
      requires_graded_questions: requiresGradedQuestions,
      summary: facts.length ? `Recorded evidence: ${facts.join('; ')}.` : lifecycleSummary,
    };
  }).filter((quest) => quest.canonical_task_id)
    .sort((left, right) => left.canonical_task_id.localeCompare(right.canonical_task_id));
}

function renderValidatedClaimSelection(selection, catalog) {
  const groups = validateClaimSelection(selection, catalog);
  const performanceClaims = groups.performance_claim_ids.map((id) => findClaim(catalog, 'performance', id));
  if (['topic_metadata_unavailable', 'topic_metadata_partial'].includes(catalog.topicEvidenceStatus)) {
    const missingTopicClaim = findClaim(catalog, 'performance', 'topic_evidence_unavailable');
    if (missingTopicClaim) performanceClaims.push(missingTopicClaim);
  }
  const performanceInsight = [...new Map(performanceClaims.map((claim) => [claim.id, claim])).values()]
    .map((claim) => claim.text)
    .join(' ');
  if (!performanceInsight || performanceInsight.length > MAX_RENDERED_PERFORMANCE_LENGTH) {
    throw new GroundingValidationError(
      'Grounding rendered performance insight is invalid.',
      INSIGHT_VALIDATION_STAGES.RENDERED_OUTPUT_INVALID
    );
  }
  const questInsights = renderQuestInsights(catalog.providerEvidence?.quest_evidence);
  const deterministicWeaknessIds = catalog.weakness.map((claim) => claim.id);
  const deterministicRecommendationIds = deriveSupportedRecommendationIds({
    performance_claim_ids: groups.performance_claim_ids,
    weakness_claim_ids: deterministicWeaknessIds,
  }, catalog);
  return {
    topic_evidence_status: catalog.topicEvidenceStatus,
    performance_insight: performanceInsight,
    strengths: renderGroup(catalog.strength.map((claim) => claim.id), catalog, 'strength'),
    weaknesses: renderGroup(deterministicWeaknessIds, catalog, 'weakness'),
    recommendations: renderGroup(
      deterministicRecommendationIds,
      catalog,
      'recommendation'
    ),
    ...(questInsights.length ? { quest_insights: questInsights } : {}),
  };
}

module.exports = {
  GROUNDING_POLICY_VERSION,
  WEAK_PERFORMANCE_THRESHOLD,
  STRENGTH_MIN_ATTEMPTS,
  STRENGTH_MIN_ACCURACY,
  INSIGHT_VALIDATION_STAGES,
  GroundingValidationError,
  buildGroundedClaimCatalog,
  buildClaimSelectionSchema,
  renderQuestInsights,
  validateClaimSelection,
  deriveSupportedRecommendationIds,
  renderValidatedClaimSelection,
};
