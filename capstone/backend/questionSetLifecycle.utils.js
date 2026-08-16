const GENERATION_STATUSES = new Set([
  'generating',
  'ready_for_review',
  'failed',
  'not_applicable',
]);

const PUBLISH_STATUSES = new Set(['staged', 'active', 'superseded']);

function normalizeGenerationStatus(row = {}) {
  if (GENERATION_STATUSES.has(row.generation_status)) {
    return row.generation_status;
  }

  return row.file_type === 'lesson' ? 'ready_for_review' : 'not_applicable';
}

function normalizePublishStatus(row = {}) {
  if (PUBLISH_STATUSES.has(row.publish_status)) {
    return row.publish_status;
  }

  return row.published ? 'active' : 'staged';
}

function publishLabel(publishStatus) {
  if (publishStatus === 'active') return 'Active in Game';
  if (publishStatus === 'superseded') return 'Superseded/Replaced';
  return 'Staged';
}

function deriveQuestionSetLifecycle(row = {}) {
  const generationStatus = normalizeGenerationStatus(row);
  const normalizedPublishStatus = normalizePublishStatus(row);

  if (generationStatus === 'failed') {
    return {
      code: 'failed',
      label: 'Failed',
      tone: 'failed',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: publishLabel(normalizedPublishStatus),
    };
  }

  if (generationStatus === 'generating') {
    return {
      code: 'generating',
      label: 'Generating',
      tone: 'generating',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: publishLabel(normalizedPublishStatus),
    };
  }

  if (normalizedPublishStatus === 'active') {
    return {
      code: 'active',
      label: 'Active in Game',
      tone: 'active',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: 'Active in Game',
    };
  }

  if (normalizedPublishStatus === 'superseded') {
    return {
      code: 'superseded',
      label: 'Superseded/Replaced',
      tone: 'superseded',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: 'Superseded/Replaced',
    };
  }

  if (generationStatus === 'ready_for_review') {
    return {
      code: 'ready_for_review',
      label: 'Ready for Review',
      tone: 'review',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: 'Staged',
    };
  }

  return {
    code: 'staged',
    label: 'Staged',
    tone: 'staged',
    generationStatus,
    publishStatus: normalizedPublishStatus,
    publishLabel: 'Staged',
  };
}

function toQuestionSetResponse(row = {}) {
  const lifecycle = deriveQuestionSetLifecycle(row);
  const isLesson = row.file_type === 'lesson';

  return {
    ...row,
    generation_status: lifecycle.generationStatus,
    publish_status: lifecycle.publishStatus,
    lifecycle,
    status: lifecycle.label,
    source_lesson: isLesson ? (row.file_name || row.title || null) : null,
    generated_question_set_name: isLesson && row.title
      ? `${row.title} — Generated Questions`
      : (row.title || null),
  };
}

module.exports = {
  deriveQuestionSetLifecycle,
  normalizeGenerationStatus,
  normalizePublishStatus,
  toQuestionSetResponse,
};
