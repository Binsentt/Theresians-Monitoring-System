const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  extractFixedQuestionDocument,
  parseFixedQuestionText,
  validateFixedQuestionUploadFile,
  validateFixedQuestions,
  validateQuestionSetForPublication,
} = require('./fixedQuestionDocument');

const VALID_DOCUMENT_TEXT = `1. What is 2 + 3?
A. 4
B. 5
C. 6
D. 7
Answer: B

2. What is 4 + 1?
A. 3
B. 4
C. 5
D. 6
Correct Answer: C`;

test('parses a teacher-formatted four-choice document into canonical question records', () => {
  const parsed = parseFixedQuestionText(VALID_DOCUMENT_TEXT);

  assert.deepEqual(parsed, [
    {
      source_index: 1,
      question: 'What is 2 + 3?',
      options: ['4', '5', '6', '7'],
      correct_answer: '5',
    },
    {
      source_index: 2,
      question: 'What is 4 + 1?',
      options: ['3', '4', '5', '6'],
      correct_answer: '5',
    },
  ]);
});

test('rejects a three-choice extracted question with a reviewable reason', () => {
  const parsed = parseFixedQuestionText(`1. What is 1 + 1?
A. 1
B. 2
C. 3
Answer: B`);
  const result = validateFixedQuestions(parsed);

  assert.equal(result.isValid, false);
  assert.deepEqual(result.questions[0].validation_errors, ['Exactly four answer choices are required.']);
});

test('rejects a five-choice extracted question without truncating its options', () => {
  const parsed = parseFixedQuestionText(`1. What is 1 + 1?
A. 1
B. 2
C. 3
D. 4
E. 5
Answer: B`);
  const result = validateFixedQuestions(parsed);

  assert.equal(result.questions[0].options.length, 5);
  assert.equal(result.isValid, false);
  assert.deepEqual(result.questions[0].validation_errors, ['Exactly four answer choices are required.']);
});

test('retains an explicitly blank fourth choice so the review identifies the missing content', () => {
  const parsed = parseFixedQuestionText(`1. What is 1 + 1?
A. 1
B. 2
C. 3
D.
Answer: B`);
  const result = validateFixedQuestions(parsed);

  assert.equal(result.questions[0].options.length, 4);
  assert.deepEqual(result.questions[0].validation_errors, ['All four answer choices must be nonempty.']);
});

test('rejects duplicate choices, missing answers, and answers that do not map to a choice', () => {
  const parsed = parseFixedQuestionText(`1. Which is correct?
A. 1
B. 1
C. 3
D. 4
Answer: B

2. Missing answer?
A. 1
B. 2
C. 3
D. 4

3. Invalid answer?
A. 1
B. 2
C. 3
D. 4
Answer: 9`);
  const result = validateFixedQuestions(parsed);

  assert.equal(result.isValid, false);
  assert.deepEqual(result.questions[0].validation_errors, [
    'Answer choices must be distinct.',
    'The correct answer must match one of the four choices.',
  ]);
  assert.deepEqual(result.questions[1].validation_errors, ['A correct answer is required.']);
  assert.deepEqual(result.questions[2].validation_errors, ['The correct answer must match one of the four choices.']);
});

test('accepts only the teacher-facing DOCX and PDF file signatures for fixed-question documents', () => {
  assert.equal(validateFixedQuestionUploadFile({
    originalname: 'set-a.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }, Buffer.from('PK\x03\x04')), '');
  assert.equal(validateFixedQuestionUploadFile({
    originalname: 'set-a.pdf',
    mimetype: 'application/pdf',
  }, Buffer.from('%PDF-1.7')), '');
  assert.match(validateFixedQuestionUploadFile({
    originalname: 'set-a.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }, Buffer.from('%PDF-1.7')), /valid DOCX/i);
});

test('extracts DOCX and fixed-question PDF text through server-side extractors without using OpenAI', async () => {
  const docx = await extractFixedQuestionDocument({ path: 'set-a.docx', originalname: 'set-a.docx' }, {
    extractDocxText: async () => VALID_DOCUMENT_TEXT,
  });
  const pdf = await extractFixedQuestionDocument({ path: 'set-a.pdf', originalname: 'set-a.pdf' }, {
    extractPdfText: async () => VALID_DOCUMENT_TEXT,
  });

  assert.equal(docx.isValid, true);
  assert.equal(pdf.isValid, true);
  assert.equal(docx.questions[0].correct_answer, '5');
  assert.equal(pdf.questions[1].correct_answer, '5');
});

test('extracts both prepared Teacher Set DOCX files into five valid four-choice questions', async () => {
  for (const fileName of [
    'grade1-easy-basic-addition-set-a.docx',
    'grade1-easy-basic-addition-set-b.docx',
  ]) {
    const result = await extractFixedQuestionDocument({
      path: path.resolve(__dirname, `../docs/teacher-fixed-question-documents/${fileName}`),
      originalname: fileName,
    });

    assert.equal(result.isValid, true);
    assert.equal(result.questions.length, 5);
    assert.ok(result.questions.every((question) => question.options.length === 4 && question.is_valid));
  }
});

test('extracts a real fixed-question PDF fixture into valid canonical questions', async () => {
  const result = await extractFixedQuestionDocument({
    path: path.resolve(__dirname, 'test-fixtures/fixed-question-four-choice.pdf'),
    originalname: 'fixed-question-four-choice.pdf',
  });

  assert.equal(result.isValid, true);
  assert.equal(result.questions.length, 2);
  assert.deepEqual(result.questions[0].options, ['4', '5', '6', '7']);
  assert.equal(result.questions[1].correct_answer, '5');
});

test('blocks publication when any stored question fails the four-choice or controlled metadata contract', () => {
  const result = validateQuestionSetForPublication({
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: 'Basic Addition',
    questions: [
      {
        question: 'What is 2 + 3?',
        options: ['4', '5', '6'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
      },
      {
        question: 'What is 4 + 1?',
        options: ['3', '4', '5', '6'],
        correct_answer: '5',
        grade_level: 'Grade 2',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
      },
    ],
  });

  assert.equal(result.isValid, false);
  assert.deepEqual(result.questions[0].validation_errors, ['Exactly four answer choices are required.']);
  assert.deepEqual(result.questions[1].validation_errors, ['Question grade must match the selected Grade.']);
});

test('treats legacy Medium and Hard question metadata as Normal and Difficult publication scopes', () => {
  const normal = validateQuestionSetForPublication({
    grade_level: 'Grade 1',
    difficulty: 'Normal',
    math_topic: 'Addition',
    questions: [{
      question: 'What is 2 + 3?',
      options: ['4', '5', '6', '7'],
      correct_answer: '5',
      grade_level: 'Grade 1',
      difficulty: 'Medium',
      math_topic: 'Addition',
    }],
  });
  const difficult = validateQuestionSetForPublication({
    grade_level: 'Grade 1',
    difficulty: 'Difficult',
    math_topic: 'Problem Solving (Addition and Subtraction)',
    questions: [{
      question: 'Ana has 8 candies and gives away 3. How many remain?',
      options: ['4', '5', '6', '7'],
      correct_answer: '5',
      grade_level: 'Grade 1',
      difficulty: 'Hard',
      math_topic: 'Problem Solving (Addition and Subtraction)',
    }],
  });

  assert.equal(normal.isValid, true);
  assert.equal(difficult.isValid, true);
});

test('allows publication validation only for fully valid stored questions with matching controlled metadata', () => {
  const result = validateQuestionSetForPublication({
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: 'Basic Addition',
    questions: [
      {
        question: 'What is 2 + 3?',
        options: ['4', '5', '6', '7'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
      },
    ],
  });

  assert.equal(result.isValid, true);
  assert.equal(result.questions[0].is_valid, true);
});
