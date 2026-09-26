const GENERATION_STATUSES = new Set([
  'queued',
  'extracting',
  'generating',
  'validating',
  'saving',
  'ready_for_review',
  'partial_failed',
  'failed',
  'not_applicable',
  'source_ready',
]);

const PUBLISH_STATUSES = new Set(['staged', 'active', 'superseded']);
const GENERATION_STAGES = new Set(['queued', 'extracting', 'generating', 'validating', 'saving', 'completed', 'failed', 'partial_failed']);

function deriveQuestionSetReviewMode(row = {}) {
  const explicitMode = String(row.review_mode || '').trim().toLowerCase();
  if (explicitMode === 'fixed' || explicitMode === 'generated' || explicitMode === 'source') return explicitMode;

  const fileType = String(row.file_type || '').trim().toLowerCase();
  const contentRole = String(row.content_role || '').trim().toLowerCase();
  const source = String(row.source || '').trim().toLowerCase();
  if (contentRole === 'lesson_source') return 'source';
  if (fileType === 'fixed' || fileType === 'fixed_questions' || ['fixed', 'restored_import', 'client_provided'].includes(source)) {
    return 'fixed';
  }
  if (
    fileType === 'lesson'
    || contentRole === 'question_set'
    || (row.source_learning_file_id !== undefined && row.source_learning_file_id !== null)
    || GENERATION_STATUSES.has(String(row.generation_status || '').trim().toLowerCase())
    || GENERATION_STAGES.has(String(row.generation_stage || '').trim().toLowerCase())
    || (row.requested_question_count !== undefined && row.requested_question_count !== null)
  ) return 'generated';
  return 'fixed';
}

function normalizeGenerationStatus(row = {}) {
  const reviewMode = deriveQuestionSetReviewMode(row);
  if (reviewMode === 'fixed') return 'not_applicable';
  if (reviewMode === 'source') return row.generation_status === 'source_ready' ? 'source_ready' : 'not_applicable';
  if (GENERATION_STATUSES.has(row.generation_status)) {
    return row.generation_status;
  }

  return reviewMode === 'generated' ? 'ready_for_review' : 'not_applicable';
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

  if (generationStatus === 'failed' || generationStatus === 'partial_failed') {
    return {
      code: generationStatus,
      label: generationStatus === 'partial_failed' ? 'Partial Failure' : 'Failed',
      tone: 'failed',
      generationStatus,
      publishStatus: normalizedPublishStatus,
      publishLabel: 'Not Generated',
      failureLabel: generationFailureLabel(row.generation_error_code),
    };
  }

  if (['queued', 'extracting', 'generating', 'validating', 'saving'].includes(generationStatus)) {
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
  const reviewMode = deriveQuestionSetReviewMode(row);
  const normalizedRow = { ...row, review_mode: reviewMode };
  const persistedQuestionCount = Number(normalizedRow.question_count);
  const requestedQuestionCount = Number(normalizedRow.requested_question_count);
  const hasPersistedQuestionCount = reviewMode === 'generated'
    && Number.isFinite(persistedQuestionCount)
    && persistedQuestionCount >= 0;

  if (hasPersistedQuestionCount) {
    normalizedRow.generation_completed_count = persistedQuestionCount;
    if (Number.isFinite(requestedQuestionCount) && requestedQuestionCount > 0) {
      normalizedRow.generation_remaining_count = Math.max(0, requestedQuestionCount - persistedQuestionCount);
    }
  }

  if (reviewMode === 'fixed') {
    normalizedRow.generation_status = 'not_applicable';
    normalizedRow.generation_stage = 'not_applicable';
  } else if (reviewMode === 'source' && normalizedRow.generation_status !== 'source_ready') {
    normalizedRow.generation_stage = 'not_applicable';
  } else if (normalizedRow.generation_status === 'ready_for_review') {
    normalizedRow.generation_stage = 'completed';
  }
  const lifecycle = deriveQuestionSetLifecycle(normalizedRow);
  const isLesson = row.file_type === 'lesson';

  return {
    ...normalizedRow,
    generation_status: lifecycle.generationStatus,
    generation_stage: normalizedRow.generation_stage,
    review_mode: reviewMode,
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
  deriveQuestionSetReviewMode,
  generationFailureLabel,
  normalizeGenerationStatus,
  normalizePublishStatus,
  sourceLabel,
  toQuestionSetResponse,
};
