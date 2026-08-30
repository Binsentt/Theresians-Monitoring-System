const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assessQuestionScope,
  validateQuestionSetScope,
} = require('./questionScopeAssessment.utils');

const BASIC_ADDITION_SCOPE = {
  grade_level: 'Grade 1',
  difficulty: 'Easy',
  math_topic: 'Basic Addition',
};

test('accepts deterministic addition evidence for Grade 1 Easy Basic Addition', () => {
  assert.deepEqual(
    assessQuestionScope({ source_index: 1, question: 'What is 4 + 3?' }, BASIC_ADDITION_SCOPE),
    { status: 'match', source_index: 1 }
  );
});

test('reports the original question number when subtraction is selected as Basic Addition', () => {
  assert.deepEqual(
    assessQuestionScope({ source_index: 3, question: 'What is 9 - 2?' }, BASIC_ADDITION_SCOPE),
    {
      status: 'mismatch',
      detected_topic: 'Subtraction',
      code: 'QUESTION_TOPIC_MISMATCH',
      source_index: 3,
    }
  );
});

test('fails closed when a question cannot be deterministically scoped', () => {
  assert.deepEqual(
    assessQuestionScope({ source_index: 4, question: 'Solve this problem.' }, BASIC_ADDITION_SCOPE),
    {
      status: 'unverified',
      code: 'QUESTION_TOPIC_UNVERIFIED',
      source_index: 4,
    }
  );
});

test('keeps scope diagnostics publication-only for a structurally valid mixed set', () => {
  const validation = validateQuestionSetScope({
    selected_scope: BASIC_ADDITION_SCOPE,
    document_topic: 'Basic Addition',
    questions: [
      { source_index: 1, question: 'What is 4 + 3?' },
      { source_index: 3, question: 'What is 9 - 2?' },
    ],
  });

  assert.equal(validation.isValid, false);
  assert.equal(validation.code, 'QUESTION_TOPIC_MISMATCH');
  assert.match(validation.message, /Question 3/i);
  assert.deepEqual(validation.question_errors, [{
    source_index: 3,
    code: 'QUESTION_TOPIC_MISMATCH',
    message: 'Question 3 is Subtraction but the selected Topic is Basic Addition.',
  }]);
});

test('validates generated questions without requiring a fixed-document topic heading', () => {
  const validation = validateQuestionSetScope({
    selected_scope: BASIC_ADDITION_SCOPE,
    require_document_topic: false,
    questions: [{ source_index: 1, question: 'What is 4 + 3?' }],
  });

  assert.deepEqual(validation, {
    isValid: true,
    code: 'ELIGIBLE',
    message: 'Question scope matches the selected game publication topic.',
    question_errors: [],
  });
});
