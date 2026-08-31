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

const SHAPES_SCOPE = {
  grade_level: 'Grade 1',
  difficulty: 'Easy',
  topic_id: 'shapes',
};

const COMPOSITE_SCOPE = {
  grade_level: 'Grade 2',
  difficulty: 'Easy',
  topic_id: 'basic_addition_subtraction',
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

test('keeps the selected arithmetic scope when no exclusive arithmetic conflict is proved', () => {
  assert.deepEqual(
    assessQuestionScope({ source_index: 4, question: 'Solve this problem.' }, BASIC_ADDITION_SCOPE),
    { status: 'match', source_index: 4 }
  );
});

test('keeps a selected non-arithmetic scope without per-question metadata or keyword classification', () => {
  assert.deepEqual(
    assessQuestionScope({ source_index: 2, question: 'How many sides does a square have?' }, SHAPES_SCOPE),
    { status: 'match', source_index: 2 }
  );
  assert.deepEqual(
    assessQuestionScope({ source_index: 2, question: 'How many sides does a square have?', topic_id: 'not_a_topic' }, SHAPES_SCOPE),
    { status: 'match', source_index: 2 }
  );
});

test('fails closed when a supplied selected topic_id is unsupported, even if its legacy label is valid', () => {
  const validation = validateQuestionSetScope({
    selected_scope: {
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      topic_id: 'not_a_topic',
      math_topic: 'Shapes',
    },
    document_topic: 'Shapes',
    questions: [{ source_index: 1, question: 'How many sides does a square have?', topic_id: 'shapes' }],
  });

  assert.equal(validation.isValid, false);
  assert.equal(validation.code, 'QUESTION_SCOPE_INVALID');
});

test('treats optional per-question topic metadata as non-authoritative for the selected scope', () => {
  assert.deepEqual(
    assessQuestionScope({ source_index: 5, question: 'How many sides does a square have?', topic_id: 'not_a_topic' }, SHAPES_SCOPE),
    { status: 'match', source_index: 5 }
  );
  assert.deepEqual(
    assessQuestionScope({ source_index: 5, question: 'How many sides does a square have?', topic_id: 'addition' }, SHAPES_SCOPE),
    { status: 'match', source_index: 5 }
  );
  assert.deepEqual(
    assessQuestionScope({ source_index: 7, question: 'What is 4 + 3?' }, COMPOSITE_SCOPE),
    { status: 'match', source_index: 7 }
  );
  assert.deepEqual(
    assessQuestionScope({ source_index: 7, question: 'What is 4 + 3?', topic_id: 'basic_addition_subtraction' }, COMPOSITE_SCOPE),
    { status: 'match', source_index: 7 }
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
    message: 'Question 3 conflicts with selected Topic: Basic Addition.',
  }]);
});

test('treats a multi-topic-looking document heading as non-authoritative display metadata', () => {
  const additionQuestions = new Set([1, 2, 4, 6, 8, 10, 11, 13, 15]);
  const questions = Array.from({ length: 15 }, (_, index) => {
    const source_index = index + 1;
    return {
      source_index,
      question: additionQuestions.has(source_index) ? `What is ${source_index} + 1?` : `What is ${source_index} - 1?`,
    };
  });

  const perQuestionScope = validateQuestionSetScope({
    selected_scope: BASIC_ADDITION_SCOPE,
    document_topic: 'Basic Addition',
    questions,
  });
  const mixedDocumentScope = validateQuestionSetScope({
    selected_scope: BASIC_ADDITION_SCOPE,
    document_topic: 'Basic Addition, Subtraction',
    questions,
  });

  assert.equal(perQuestionScope.code, 'QUESTION_TOPIC_MISMATCH');
  assert.deepEqual(perQuestionScope.question_errors.map((error) => error.source_index), [3, 5, 7, 9, 12, 14]);
  assert.equal(mixedDocumentScope.code, 'QUESTION_TOPIC_MISMATCH');
  assert.deepEqual(mixedDocumentScope.question_errors.map((error) => error.source_index), [3, 5, 7, 9, 12, 14]);
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
