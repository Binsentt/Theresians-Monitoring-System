const GENERATION_STATUSES = new Set([
  'generating',
  'ready_for_review',
  'failed',
  'not_applicable',
  'source_ready',
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
  if (publishStatus === 'superseded') return 'Replaced';
  return 'Pending';
}

function sourceLabel(source) {
  if (source === 'restored_import' || source === 'client_provided') return 'Client Provided';
  if (source === 'lesson' || source === 'ai') return 'AI Generated';
  return 'Fixed Question File';
}

function generationFailureLabel(errorCode) {
  if (errorCode === 'QUESTION_AI_TIMEOUT') return 'Question generation timed out. Retry the upload.';
  if (errorCode === 'QUESTION_AI_INVALID_RESPONSE') return 'Question AI returned unusable question data. Retry the upload.';
  if (errorCode === 'QUESTION_AI_EMPTY_LESSON') return 'No readable lesson text was found.';
  if (errorCode === 'QUESTION_AI_LESSON_TOO_LARGE') return 'The readable lesson text exceeds the safe size limit.';
  if (errorCode === 'QUESTION_AI_NOT_CONFIGURED') return 'Question AI is not configured. Contact the administrator.';
  return 'Question AI is unavailable. Retry after the service is restored.';
}

function deriveQuestionSetLifecycle(row = {}) {
  const generationStatus = normalizeGenerationStatus(row);
  const normalizedPublishStatus = normalizePublishStatus(row);

  if (generationStatus === 'source_ready') {
    return {
      code: 'source_ready',
      label: 'Source Ready',
      tone: 'staged',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: 'Not Generated',
    };
  }

  if (generationStatus === 'failed') {
    return {
      code: 'failed',
      label: 'Failed',
      tone: 'failed',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: 'Not Generated',
      failureLabel: generationFailureLabel(row.generation_error_code),
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
      label: 'Replaced',
      tone: 'superseded',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: 'Replaced',
    };
  }

  if (normalizedPublishStatus === 'staged' && row.approval_status === 'approved') {
    return {
      code: 'approved_inactive',
      label: 'Approved',
      tone: 'approved',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: 'Not in Game',
    };
  }

  if (generationStatus === 'ready_for_review') {
    return {
      code: 'ready_for_review',
      label: 'Ready for Review',
      tone: 'review',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: 'Pending',
    };
  }

  return {
    code: 'staged',
    label: 'Pending',
    tone: 'staged',
    generationStatus,
    publishStatus: normalizedPublishStatus,
    publishLabel: 'Pending',
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
    source_label: sourceLabel(row.source),
    source_lesson: isLesson ? (row.file_name || row.title || null) : null,
    generated_question_set_name: isLesson && row.title
      ? `${row.title} — Generated Questions`
      : (row.title || null),
  };
}

module.exports = {
  deriveQuestionSetLifecycle,
  generationFailureLabel,
  normalizeGenerationStatus,
  normalizePublishStatus,
  sourceLabel,
  toQuestionSetResponse,
};
