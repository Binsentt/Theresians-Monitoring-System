const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveQuestionSetLifecycle,
  toQuestionSetResponse,
} = require('./questionSetLifecycle.utils');

test('reports ready lesson sets as ready for review while they remain staged', () => {
  const lifecycle = deriveQuestionSetLifecycle({
    file_type: 'lesson',
    generation_status: 'ready_for_review',
    publish_status: 'staged',
    published: false,
  });

  assert.equal(lifecycle.code, 'ready_for_review');
  assert.equal(lifecycle.label, 'Ready for Review');
  assert.equal(lifecycle.publishLabel, 'Pending');
});

test('uses the persisted active, superseded, generating, and failed states', () => {
  assert.equal(
    deriveQuestionSetLifecycle({ publish_status: 'active', published: true }).label,
    'Active in Game'
  );
  assert.equal(
    deriveQuestionSetLifecycle({ publish_status: 'superseded', published: false }).label,
    'Replaced'
  );
  assert.equal(
    deriveQuestionSetLifecycle({ generation_status: 'generating', publish_status: 'staged' }).label,
    'Generating'
  );
  const failed = deriveQuestionSetLifecycle({
    generation_status: 'failed',
    generation_error_code: 'QUESTION_AI_GENERATION_FAILED',
    publish_status: 'staged',
  });
  assert.equal(failed.label, 'Failed');
  assert.equal(failed.publishLabel, 'Not Generated');
  assert.equal(failed.failureLabel, 'Question AI is unavailable. Retry after the service is restored.');
});

test('reports an approved staged set as approved but not in the game', () => {
  const lifecycle = deriveQuestionSetLifecycle({
    approval_status: 'approved',
    publish_status: 'staged',
    published: false,
  });

  assert.equal(lifecycle.code, 'approved_inactive');
  assert.equal(lifecycle.label, 'Approved');
  assert.equal(lifecycle.publishLabel, 'Not in Game');
});

test('adds source traceability labels without fabricating a lifecycle', () => {
  const lesson = toQuestionSetResponse({
    id: 7,
    title: 'Fractions Lesson',
    file_name: 'fractions.pdf',
    file_type: 'lesson',
    generation_status: 'ready_for_review',
    publish_status: 'staged',
  });
  const fixed = toQuestionSetResponse({
    id: 8,
    title: 'Prepared Fractions',
    file_name: 'fractions.json',
    file_type: 'fixed',
    publish_status: 'staged',
  });

  assert.equal(lesson.source_lesson, 'fractions.pdf');
  assert.equal(lesson.generated_question_set_name, 'Fractions Lesson — Generated Questions');
  assert.equal(lesson.status, 'Ready for Review');
  assert.equal(fixed.source_lesson, null);
  assert.equal(fixed.generated_question_set_name, 'Prepared Fractions');
  assert.equal(fixed.status, 'Pending');
  assert.equal(toQuestionSetResponse({ source: 'restored_import' }).source_label, 'Client Provided');
  assert.equal(toQuestionSetResponse({ source: 'fixed' }).source_label, 'Fixed Question File');
  assert.equal(toQuestionSetResponse({ source: 'lesson' }).source_label, 'AI Generated');
});

test('fixed question sets never inherit an AI generation status from stale rows', () => {
  const response = toQuestionSetResponse({
    id: 19,
    file_type: 'fixed_questions',
    review_mode: 'fixed',
    generation_status: 'generating',
    generation_stage: 'generating',
    publish_status: 'staged',
  });

  assert.equal(response.review_mode, 'fixed');
  assert.equal(response.generation_status, 'not_applicable');
  assert.equal(response.generation_stage, 'not_applicable');
  assert.equal(response.lifecycle.code, 'staged');
  assert.equal(response.lifecycle.label, 'Pending');
});

test('generated lesson children expose an authoritative generated review mode', () => {
  const response = toQuestionSetResponse({
    id: 20,
    file_type: 'lesson',
    content_role: 'question_set',
    source_learning_file_id: 7,
    generation_status: 'generating',
    generation_stage: 'generating',
  });

  assert.equal(response.review_mode, 'generated');
  assert.equal(response.generation_status, 'generating');
  assert.equal(response.generation_stage, 'generating');
});

test('generated lifecycle counts reconcile to persisted question rows without overriding the worker lifecycle', () => {
  const response = toQuestionSetResponse({
    id: 21,
    file_type: 'lesson',
    content_role: 'question_set',
    source_learning_file_id: 8,
    requested_question_count: 10,
    question_count: 5,
    generation_status: 'generating',
    generation_stage: 'generating',
    generation_completed_count: 0,
    generation_remaining_count: 10,
  });

  assert.equal(response.generation_completed_count, 5);
  assert.equal(response.generation_remaining_count, 5);
  assert.equal(response.generation_status, 'generating');

  const complete = toQuestionSetResponse({
    ...response,
    question_count: 10,
    generation_status: 'generating',
    generation_stage: 'generating',
  });
  assert.equal(complete.generation_completed_count, 10);
  assert.equal(complete.generation_remaining_count, 0);
  assert.equal(complete.generation_status, 'generating');
  assert.equal(complete.generation_stage, 'generating');
});

test('partial generated children retain their persisted partial status and count', () => {
  const response = toQuestionSetResponse({
    id: 22,
    file_type: 'lesson',
    content_role: 'question_set',
    source_learning_file_id: 9,
    requested_question_count: 10,
    question_count: 5,
    generation_status: 'partial_failed',
    generation_stage: 'partial_failed',
    generation_completed_count: 0,
    generation_remaining_count: 10,
  });

  assert.equal(response.generation_status, 'partial_failed');
  assert.equal(response.generation_stage, 'partial_failed');
  assert.equal(response.generation_completed_count, 5);
  assert.equal(response.generation_remaining_count, 5);
  assert.equal(response.lifecycle.code, 'partial_failed');
});
