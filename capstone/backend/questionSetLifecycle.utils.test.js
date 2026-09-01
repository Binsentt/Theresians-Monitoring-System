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
  assert.equal(
    deriveQuestionSetLifecycle({ generation_status: 'failed', publish_status: 'staged' }).label,
    'Failed'
  );
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
