const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LessonTopicExtractionError,
  allocateLessonQuestionTargets,
  resolveHeadingTopic,
  resolveLessonTopicSections,
} = require('./lessonTopicExtraction');

test('rejects a label that matches multiple canonical Mathematics topics as ambiguous', () => {
  const matchingTopics = [
    { topic_id: 'synthetic_topic_one', display_label: 'Shared Label', aliases: [] },
    { topic_id: 'synthetic_topic_two', display_label: 'Shared Label', aliases: [] },
  ];

  assert.deepEqual(resolveHeadingTopic('Shared Label', matchingTopics, matchingTopics), { kind: 'ambiguous' });
});

test('resolves one explicit canonical topic heading inside the selected Grade/Difficulty scope', () => {
  const result = resolveLessonTopicSections({
    lessonText: 'Grade 1 practice\nTopic: Basic Addition\nAdd two groups of objects.',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
  });

  assert.deepEqual(result, [{
    topic_id: 'basic_addition',
    math_topic: 'Basic Addition',
    section_text: 'Add two groups of objects.',
  }]);
});

test('recognizes canonical topic names in common document heading forms', () => {
  const fixtures = [
    'Basic Addition\nAdd two groups of objects.',
    '## Basic Addition\nAdd two groups of objects.',
    'Unit 1 — Basic Addition\nAdd two groups of objects.',
    'Mathematics Topic: Basic Addition\nAdd two groups of objects.',
  ];

  for (const lessonText of fixtures) {
    assert.deepEqual(resolveLessonTopicSections({
      lessonText,
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
    }), [{
      topic_id: 'basic_addition',
      math_topic: 'Basic Addition',
      section_text: 'Add two groups of objects.',
    }]);
  }
});

test('extracts an exact canonical topic from a Grade/Difficulty metadata heading', () => {
  assert.deepEqual(resolveLessonTopicSections({
    lessonText: 'Grade 1 · Easy · Basic Addition · 5 Questions\nAdd groups and find totals.',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
  }), [{
    topic_id: 'basic_addition',
    math_topic: 'Basic Addition',
    section_text: 'Add groups and find totals.',
  }]);
});

test('rejects a scope-qualified document heading whose topic cannot be validated', () => {
  assert.throws(() => resolveLessonTopicSections({
    lessonText: 'Grade 1 · Easy · Arithmetic Review · 5 Questions\nPractice with counters.',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
  }), (error) => error instanceof LessonTopicExtractionError && error.code === 'LESSON_TOPIC_UNKNOWN');
});

test('rejects a scope-qualified topic when its declared Grade/Difficulty conflicts with the upload selection', () => {
  assert.throws(() => resolveLessonTopicSections({
    lessonText: 'Grade 1 · Normal · Basic Addition · 5 Questions\nAdd groups and find totals.',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
  }), (error) => error instanceof LessonTopicExtractionError && error.code === 'LESSON_TOPIC_SCOPE_MISMATCH');
});

test('splits a multi-topic lesson into canonical sections without combining their evidence', () => {
  const result = resolveLessonTopicSections({
    lessonText: [
      'Topic: Basic Addition',
      'Add groups and find totals.',
      'Topic: Subtraction',
      'Take away objects and compare what remains.',
    ].join('\n'),
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
  });

  assert.deepEqual(result.map(({ topic_id, math_topic, section_text }) => ({ topic_id, math_topic, section_text })), [
    { topic_id: 'basic_addition', math_topic: 'Basic Addition', section_text: 'Add groups and find totals.' },
    { topic_id: 'subtraction', math_topic: 'Subtraction', section_text: 'Take away objects and compare what remains.' },
  ]);
});

test('recognizes multiple canonical topics across differently formatted headings', () => {
  const result = resolveLessonTopicSections({
    lessonText: [
      '## Basic Addition',
      'Add groups and find totals.',
      'Lesson 2: Subtraction',
      'Take away objects and compare what remains.',
    ].join('\n'),
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
  });

  assert.deepEqual(result.map(({ topic_id, section_text }) => ({ topic_id, section_text })), [
    { topic_id: 'basic_addition', section_text: 'Add groups and find totals.' },
    { topic_id: 'subtraction', section_text: 'Take away objects and compare what remains.' },
  ]);
});

test('does not infer a topic from ordinary lesson text or a manual caller hint', () => {
  for (const lessonText of [
    'This lesson includes addition and subtraction practice.',
    'Basic Addition is discussed while adding groups and finding totals.',
  ]) {
    assert.throws(() => resolveLessonTopicSections({
      lessonText,
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
    }), (error) => error instanceof LessonTopicExtractionError && error.code === 'LESSON_TOPIC_HEADING_REQUIRED');
  }
});

test('rejects a canonical document heading that is outside the selected Grade/Difficulty scope', () => {
  assert.throws(() => resolveLessonTopicSections({
    lessonText: '## Fractions\nCompare the parts of a whole.',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
  }), (error) => error instanceof LessonTopicExtractionError && error.code === 'LESSON_TOPIC_OUT_OF_SCOPE');
});

test('rejects an explicit unknown or out-of-scope topic heading instead of defaulting to another topic', () => {
  assert.throws(() => resolveLessonTopicSections({
    lessonText: 'Topic: Fractions\nCompare the parts of a whole.',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
  }), (error) => error instanceof LessonTopicExtractionError && error.code === 'LESSON_TOPIC_OUT_OF_SCOPE');

  assert.throws(() => resolveLessonTopicSections({
    lessonText: 'Topic: Fractions Practice\nCompare the parts of a whole.',
    gradeLevel: 'Grade 1',
    difficulty: 'Easy',
  }), (error) => error instanceof LessonTopicExtractionError && error.code === 'LESSON_TOPIC_UNKNOWN');
});

test('question allocation covers each identified topic and preserves existing per-question topic assignments', () => {
  const sections = [
    { topic_id: 'basic_addition' },
    { topic_id: 'subtraction' },
  ];
  const plan = allocateLessonQuestionTargets({
    sections,
    questionCount: 5,
    existingQuestions: [{ topic_id: 'basic_addition' }, { topic_id: 'basic_addition' }],
  });

  assert.deepEqual(plan, [
    { topic_id: 'basic_addition', target_count: 3, existing_count: 2 },
    { topic_id: 'subtraction', target_count: 2, existing_count: 0 },
  ]);
});

test('requires enough requested questions to represent every extracted topic', () => {
  assert.throws(() => allocateLessonQuestionTargets({
    sections: [{ topic_id: 'basic_addition' }, { topic_id: 'subtraction' }],
    questionCount: 1,
    existingQuestions: [],
  }), (error) => error instanceof LessonTopicExtractionError && error.code === 'LESSON_QUESTION_COUNT_BELOW_TOPIC_COUNT');
});
