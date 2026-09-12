const GROUNDING_POLICY_VERSION = 'grounded-claims-v1';
const WEAK_PERFORMANCE_THRESHOLD = 75;
const MAX_SELECTION_ITEMS = 5;
const MAX_TOPIC_LABEL_LENGTH = 80;
const MAX_RENDERED_PERFORMANCE_LENGTH = 900;

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

const asSafeTopicLabel = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TOPIC_LABEL_LENGTH || /[\r\n\t]/.test(normalized)) return null;
  return normalized;
};

const asSafeQuestLabel = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TOPIC_LABEL_LENGTH || /[\r\n\t]/.test(normalized)) return null;
  return normalized;
};

const topicSlug = (value) => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

const createCatalog = (input) => ({
  policyVersion: GROUNDING_POLICY_VERSION,
  providerEvidence: input,
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

const addAccuracyClaims = ({ catalog, subjectId, subjectLabel, accuracy, category }) => {
  if (!isFiniteNumber(accuracy)) return;
  const accuracyText = formatPercentage(accuracy);
  const accuracyClaimId = `${subjectId}_accuracy`;
  if (category === 'performance') {
    addPerformanceClaim(catalog, accuracyClaimId, `Recorded ${subjectLabel} accuracy is ${accuracyText}.`);
  }

  if (accuracy >= WEAK_PERFORMANCE_THRESHOLD) {
    addClaim(catalog, 'strength', {
      id: `${subjectId}_strength`,
      text: `Recorded ${subjectLabel} accuracy is ${accuracyText}, meeting the current positive-evidence boundary.`,
    });
    return;
  }

  addClaim(catalog, 'weakness', {
    id: `${subjectId}_weakness`,
    text: `Recorded ${subjectLabel} accuracy is ${accuracyText}, below the current ${WEAK_PERFORMANCE_THRESHOLD}% evidence boundary.`,
  });
  addClaim(catalog, 'recommendation', {
    id: `practice_${subjectId}`,
    supportId: `${subjectId}_weakness`,
    supportCategory: 'weakness',
    text: `Provide additional ${subjectLabel} practice based on the recorded ${accuracyText} accuracy.`,
  });
};

function addRecordedPerformanceClaims(catalog, input) {
  if (isNonNegativeInteger(input.results_recorded)) {
    addPerformanceClaim(catalog, 'results_recorded', `${input.results_recorded} valid gameplay results are recorded.`);
  }
  if (isNonNegativeInteger(input.correct_answers) && isNonNegativeInteger(input.incorrect_answers)) {
    addPerformanceClaim(catalog, 'answer_counts', `Recorded answers: ${input.correct_answers} correct answers and ${input.incorrect_answers} incorrect answers.`);
  }
  if (isFiniteNumber(input.accuracy)) {
    addPerformanceClaim(catalog, 'overall_accuracy', `Recorded overall accuracy is ${formatPercentage(input.accuracy)}.`);
    addAccuracyClaims({
      catalog,
      subjectId: 'overall_accuracy',
      subjectLabel: 'overall',
      accuracy: input.accuracy,
      category: 'non-performance',
    });
  }
  if (isFiniteNumber(input.game_score)) {
    addPerformanceClaim(catalog, 'game_score', `Recorded game score is ${formatNumber(input.game_score)}.`);
  }
  if (input.total_progress_verified === true && isFiniteNumber(input.total_progress)) {
    addPerformanceClaim(catalog, 'total_progress', `Recorded total progress is ${formatPercentage(input.total_progress)}.`);
  }
  if (isNonNegativeInteger(input.completed_quests)) {
    addPerformanceClaim(catalog, 'completed_quests', `Recorded completed quests: ${input.completed_quests}.`);
    if (input.completed_quests > 0) {
      addClaim(catalog, 'strength', {
        id: 'completed_quests_strength',
        text: `Recorded progress includes ${input.completed_quests} completed quest${input.completed_quests === 1 ? '' : 's'}.`,
      });
    }
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
      addClaim(catalog, 'recommendation', {
        id: `collect_difficulty_${id}_data`,
        supportId: noDataId,
        supportCategory: 'performance',
        text: `Record more ${label} gameplay to establish performance evidence.`,
      });
      return;
    }
    addAccuracyClaims({
      catalog,
      subjectId: `difficulty_${id}`,
      subjectLabel: label,
      accuracy,
      category: 'performance',
    });
  });
}

function addObservedTopicClaims(catalog, topicPerformance) {
  if (!Array.isArray(topicPerformance)) return;
  const seenTopicIds = new Set();
  topicPerformance.forEach((topic) => {
    const label = asSafeTopicLabel(topic?.topic);
    const slug = label ? topicSlug(label) : '';
    if (!slug || seenTopicIds.has(slug)) return;
    seenTopicIds.add(slug);
    addAccuracyClaims({
      catalog,
      subjectId: `topic_${slug}`,
      subjectLabel: label,
      accuracy: topic?.accuracy,
      category: 'performance',
    });
  });
}

function freezeCatalog(catalog) {
  const freezeEntries = (entries) => Object.freeze(entries.slice());
  const frozen = {
    policyVersion: catalog.policyVersion,
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
  addObservedTopicClaims(catalog, input.topic_performance);
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
      'recommendation_claim_ids',
    ],
    properties: {
      grounding_policy_version: { type: 'string', enum: [catalog.policyVersion] },
      performance_claim_ids: arraySchemaFor(catalog.permittedClaimIds.performance, 1),
      strength_claim_ids: arraySchemaFor(catalog.permittedClaimIds.strength),
      weakness_claim_ids: arraySchemaFor(catalog.permittedClaimIds.weakness),
      recommendation_claim_ids: arraySchemaFor(catalog.permittedClaimIds.recommendation),
    },
  };
}

const selectionKeys = [
  'grounding_policy_version',
  'performance_claim_ids',
  'strength_claim_ids',
  'weakness_claim_ids',
  'recommendation_claim_ids',
];

const categoryForSelectionKey = {
  performance_claim_ids: 'performance',
  strength_claim_ids: 'strength',
  weakness_claim_ids: 'weakness',
  recommendation_claim_ids: 'recommendation',
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

  const selectedPerformance = new Set(groups.performance_claim_ids);
  const selectedWeakness = new Set(groups.weakness_claim_ids);
  groups.recommendation_claim_ids.forEach((id) => {
    const claim = findClaim(catalog, 'recommendation', id);
    const supported = claim.supportCategory === 'weakness'
      ? selectedWeakness.has(claim.supportId)
      : selectedPerformance.has(claim.supportId);
    if (!supported) {
      throw new GroundingValidationError(
        `Grounding recommendation ${id} is missing its supporting evidence.`,
        INSIGHT_VALIDATION_STAGES.CLAIM_SUPPORT_INVALID
      );
    }
  });
  return Object.freeze({
    grounding_policy_version: catalog.policyVersion,
    ...groups,
  });
}

function renderGroup(ids, catalog, category, separator = '\n') {
  const text = ids.map((id) => findClaim(catalog, category, id).text);
  return category === 'performance' ? text.join(separator) : text;
}

function renderValidatedClaimSelection(selection, catalog) {
  const groups = validateClaimSelection(selection, catalog);
  const performanceInsight = renderGroup(groups.performance_claim_ids, catalog, 'performance', ' ');
  if (!performanceInsight || performanceInsight.length > MAX_RENDERED_PERFORMANCE_LENGTH) {
    throw new GroundingValidationError(
      'Grounding rendered performance insight is invalid.',
      INSIGHT_VALIDATION_STAGES.RENDERED_OUTPUT_INVALID
    );
  }
  return {
    performance_insight: performanceInsight,
    strengths: renderGroup(groups.strength_claim_ids, catalog, 'strength'),
    weaknesses: renderGroup(groups.weakness_claim_ids, catalog, 'weakness'),
    recommendations: renderGroup(groups.recommendation_claim_ids, catalog, 'recommendation'),
  };
}

module.exports = {
  GROUNDING_POLICY_VERSION,
  WEAK_PERFORMANCE_THRESHOLD,
  INSIGHT_VALIDATION_STAGES,
  GroundingValidationError,
  buildGroundedClaimCatalog,
  buildClaimSelectionSchema,
  validateClaimSelection,
  renderValidatedClaimSelection,
};
