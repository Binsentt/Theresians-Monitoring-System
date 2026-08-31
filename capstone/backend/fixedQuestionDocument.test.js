const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  detectFixedQuestionDocumentFormat,
  extractFixedQuestionDocument,
  parseFixedQuestionText,
  resolveFixedQuestionDocumentMetadata,
  validateFixedQuestionDocumentPublicationScope,
  validateFixedQuestionUploadFile,
  validateFixedQuestions,
  validateQuestionSetForReview,
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

test('parses flattened DOCX/PDF bullet markers into one four-choice question', () => {
  const parsed = parseFixedQuestionText('1. 5 + 2 = ? ● A. 8 ● B. 7 ● C. 6 ● D. 9 Answer: B. 7');

  assert.deepEqual(parsed, [{
    source_index: 1,
    question: '5 + 2 = ?',
    options: ['8', '7', '6', '9'],
    correct_answer: '7',
  }]);
  assert.equal(validateFixedQuestions(parsed).isValid, true);
});

test('parses all five representative flattened teacher question types without weakening validation', () => {
  const parsed = parseFixedQuestionText(`GRADE 1
EASY – Lesson: Basic Addition, Subtraction, Shapes, and Place Value
1. 5 + 2 = ? ● A. 8 ● B. 7 ● C. 6 ● D. 9 Answer: B. 7
2. Which shape has three sides? ● A. Square ● B. Triangle ● C. Rectangle ● D. Circle Answer: B. Triangle
3. Ana has 3 apples and gets 2 more. How many apples does she have? ● A. 4 ● B. 5 ● C. 6 ● D. 7 Answer: B. 5
4. 9 - 4 = ? ● A. 3 ● B. 4 ● C. 5 ● D. 6 Answer: C. 5
5. Which number comes after 8? ● A. 7 ● B. 8 ● C. 9 ● D. 10 Answer: C. 9`);

  assert.equal(parsed.length, 5);
  assert.deepEqual(parsed.map((question) => question.source_index), [1, 2, 3, 4, 5]);
  assert.ok(parsed.every((question) => question.options.length === 4));
  assert.deepEqual(parsed.map((question) => question.correct_answer), ['7', 'Triangle', '5', '5', '9']);
  assert.equal(validateFixedQuestions(parsed).isValid, true);
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
  }, Buffer.from('PK\x03\x04word/document.xml')), '');
  assert.equal(validateFixedQuestionUploadFile({
    originalname: 'set-a.pdf',
    mimetype: 'application/pdf',
  }, Buffer.from('%PDF-1.7')), '');
  assert.match(validateFixedQuestionUploadFile({
    originalname: 'set-a.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }, Buffer.from('%PDF-1.7')), /MIME type.*content/i);
  assert.match(validateFixedQuestionUploadFile({
    originalname: 'set-a.doc',
    mimetype: 'application/msword',
  }, Buffer.from('D0CF11E0')), /valid PDF or DOCX/i);
});

test('detects fixed-question documents from matching MIME and content rather than chained suffixes', () => {
  const pdfFile = {
    originalname: 'grade1-set.docx.pdf',
    mimetype: 'application/pdf',
  };
  const docxFile = {
    originalname: 'grade1-set.pdf.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };

  assert.equal(detectFixedQuestionDocumentFormat(pdfFile, Buffer.from('%PDF-1.7')), 'pdf');
  assert.equal(detectFixedQuestionDocumentFormat(docxFile, Buffer.from('PK\x03\x04word/document.xml')), 'docx');
  assert.match(validateFixedQuestionUploadFile({
    originalname: 'grade1-set.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }, Buffer.from('%PDF-1.7')), /MIME type.*content/i);
  assert.match(validateFixedQuestionUploadFile({
    originalname: 'grade1-set.pdf',
    mimetype: 'application/pdf',
  }, Buffer.from('PK\x03\x04word/document.xml')), /MIME type.*content/i);
});

test('preserves a multi-topic document heading without assigning a game publication scope', () => {
  const metadata = resolveFixedQuestionDocumentMetadata({
    documentText: `GRADE 1\n\nEASY – Lesson: Basic Addition, Subtraction, Shapes, and Place Value`,
    selectedGradeLevel: 'Grade 1',
    selectedDifficulty: 'Easy',
  });

  assert.deepEqual(metadata, {
    document_topic: 'Basic Addition, Subtraction, Shapes, and Place Value',
    math_topic: null,
    metadata_error: '',
  });
});

test('maps a matching single controlled document topic to the only game publication scope', () => {
  const metadata = resolveFixedQuestionDocumentMetadata({
    documentText: `GRADE 1\nEASY – Lesson: Basic Addition`,
    selectedGradeLevel: 'Grade 1',
    selectedDifficulty: 'Easy',
  });

  assert.equal(metadata.document_topic, 'Basic Addition');
  assert.equal(metadata.math_topic, 'Basic Addition');
  assert.equal(metadata.metadata_error, '');
});

test('retains Grade and Difficulty document headings as non-authoritative provenance', () => {
  const gradeConflict = resolveFixedQuestionDocumentMetadata({
    documentText: `GRADE 2\nEASY – Lesson: Shapes`,
    selectedGradeLevel: 'Grade 1',
    selectedDifficulty: 'Easy',
  });
  const difficultyConflict = resolveFixedQuestionDocumentMetadata({
    documentText: `GRADE 1\nDIFFICULT – Lesson: Problem Solving (Addition and Subtraction)`,
    selectedGradeLevel: 'Grade 1',
    selectedDifficulty: 'Easy',
  });

  assert.equal(gradeConflict.metadata_error, '');
  assert.equal(difficultyConflict.metadata_error, '');
});

test('extracts DOCX and fixed-question PDF text through server-side extractors without using OpenAI', async () => {
  const docx = await extractFixedQuestionDocument({
    path: 'set-a.docx',
    originalname: 'set-a.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from('PK\x03\x04word/document.xml'),
  }, {
    extractDocxText: async () => VALID_DOCUMENT_TEXT,
  });
  const pdf = await extractFixedQuestionDocument({
    path: 'set-a.pdf',
    originalname: 'set-a.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7'),
  }, {
    extractPdfText: async () => VALID_DOCUMENT_TEXT,
  });

  assert.equal(docx.isValid, true);
  assert.equal(pdf.isValid, true);
  assert.equal(docx.questions[0].correct_answer, '5');
  assert.equal(pdf.questions[1].correct_answer, '5');
});

test('parses explicit per-question topic_id metadata without deriving it from question text', () => {
  const parsed = parseFixedQuestionText(`1. How many sides does a square have?
Topic ID: shapes
A. 3
B. 4
C. 5
D. 6
Answer: B`);

  assert.deepEqual(parsed, [{
    source_index: 1,
    question: 'How many sides does a square have?',
    topic_id: 'shapes',
    options: ['3', '4', '5', '6'],
    correct_answer: '4',
  }]);
});

test('keeps fixed-question parsing and selected-scope evidence independent of filename', async () => {
  const first = await extractFixedQuestionDocument({
    path: 'different-name-one.docx',
    originalname: 'different-name-one.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from('PK\x03\x04word/document.xml'),
  }, { extractDocxText: async () => VALID_DOCUMENT_TEXT });
  const second = await extractFixedQuestionDocument({
    path: 'another-name-two.docx',
    originalname: 'another-name-two.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from('PK\x03\x04word/document.xml'),
  }, { extractDocxText: async () => VALID_DOCUMENT_TEXT });

  assert.deepEqual(second.questions, first.questions);
  assert.deepEqual(
    resolveFixedQuestionDocumentMetadata({
      documentText: first.document_text,
      selectedGradeLevel: 'Grade 1',
      selectedDifficulty: 'Easy',
    }),
    resolveFixedQuestionDocumentMetadata({
      documentText: second.document_text,
      selectedGradeLevel: 'Grade 1',
      selectedDifficulty: 'Easy',
    })
  );
});

test('extracts both prepared Teacher Set DOCX files into five valid four-choice questions', async () => {
  for (const fileName of [
    'grade1-easy-basic-addition-set-a.docx',
    'grade1-easy-basic-addition-set-b.docx',
  ]) {
    const result = await extractFixedQuestionDocument({
      path: path.resolve(__dirname, `../docs/teacher-fixed-question-documents/${fileName}`),
      originalname: fileName,
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
    mimetype: 'application/pdf',
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

test('accepts a canonical topic_id as the publication metadata authority', () => {
  const result = validateQuestionSetForPublication({
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    topic_id: 'shapes',
    questions: [{
      question: 'How many sides does a square have?',
      options: ['3', '4', '5', '6'],
      correct_answer: '4',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      topic_id: 'shapes',
    }],
  });

  assert.equal(result.isValid, true);
  assert.equal(result.document_errors.length, 0);
});

test('accepts a declared non-arithmetic canonical scope without per-question topic metadata', () => {
  const questions = [{
    question: 'How many sides does a square have?',
    options: ['3', '4', '5', '6'],
    correct_answer: '4',
    grade_level: 'Grade 1',
    difficulty: 'Easy',
  }];
  const scopeValidation = require('./questionScopeAssessment.utils').validateQuestionSetScope({
    selected_scope: {
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      topic_id: 'shapes',
    },
    document_topic: 'Basic Addition, Subtraction, Shapes, and Place Value',
    questions,
  });
  const result = validateQuestionSetForPublication({
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    topic_id: 'shapes',
    math_topic: 'Shapes',
    questions,
    scope_validation: scopeValidation,
  });

  assert.equal(scopeValidation.isValid, true);
  assert.equal(result.isValid, true);
  assert.deepEqual(result.document_errors, []);
});

test('allows structural review for a valid mixed-topic document while publication remains blocked', () => {
  const mixedQuestions = [
    {
      question: 'What is 2 + 3?',
      options: ['3', '4', '5', '6'],
      correct_answer: '5',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: null,
    },
    {
      question: 'What is 5 - 2?',
      options: ['2', '3', '4', '5'],
      correct_answer: '3',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: null,
    },
  ];

  const review = validateQuestionSetForReview({
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: null,
    questions: mixedQuestions,
  });
  const publication = validateQuestionSetForPublication({
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: null,
    questions: mixedQuestions,
  });

  assert.equal(review.isValid, true);
  assert.ok(review.questions.every((question) => question.is_valid));
  assert.equal(publication.isValid, false);
  assert.match(publication.document_errors.join(' '), /Topic must match/i);
});

test('keeps invalid question structure and controlled metadata as structural review failures', () => {
  const review = validateQuestionSetForReview({
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: 'Basic Addition',
    questions: [
      {
        question: 'What is 2 + 3?',
        options: ['3', '4', '5'],
        correct_answer: '5',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
      },
      {
        question: 'What is 4 + 1?',
        options: ['3', '4', '5', '5'],
        correct_answer: '5',
        grade_level: 'Grade 2',
        difficulty: 'Normal',
        math_topic: 'Subtraction',
      },
    ],
  });

  assert.equal(review.isValid, false);
  assert.deepEqual(review.questions[0].validation_errors, ['Exactly four answer choices are required.']);
  assert.deepEqual(review.questions[1].validation_errors, [
    'Answer choices must be distinct.',
    'The correct answer must match one of the four choices.',
    'Question grade must match the selected Grade.',
    'Question difficulty must match the selected Difficulty.',
  ]);
});

test('blocks publication when a fixed-question document has no single controlled game topic', () => {
  const result = validateQuestionSetForPublication({
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: null,
    questions: [{
      question: 'What is 2 + 3?',
      options: ['4', '5', '6', '7'],
      correct_answer: '5',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: null,
    }],
  });

  assert.equal(result.isValid, false);
  assert.match(result.document_errors.join(' '), /Topic must match/i);
});

test('retains a mixed fixed-question document heading as non-authoritative display metadata', () => {
  const error = validateFixedQuestionDocumentPublicationScope({
    file_type: 'fixed_questions',
    document_topic: 'Basic Addition, Subtraction, Shapes, and Place Value',
    math_topic: 'Basic Addition',
  });

  assert.equal(error, '');
  assert.equal(validateFixedQuestionDocumentPublicationScope({
    file_type: 'fixed_questions',
    document_topic: 'Basic Addition',
    math_topic: 'Basic Addition',
  }), '');
  assert.equal(validateFixedQuestionDocumentPublicationScope({
    file_type: 'fixed_questions',
    document_topic: null,
    math_topic: 'Basic Addition',
  }), '');
});

test('keeps a topic-scope mismatch out of structural review while blocking publication', () => {
  const input = {
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: 'Basic Addition',
    questions: [{
      source_index: 3,
      question: 'What is 9 - 2?',
      options: ['5', '6', '7', '8'],
      correct_answer: '7',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Subtraction',
    }],
  };

  const review = validateQuestionSetForReview(input);
  const publication = validateQuestionSetForPublication({
    ...input,
    scope_validation: {
      isValid: false,
      code: 'QUESTION_TOPIC_MISMATCH',
      message: 'Question 3 conflicts with selected Topic: Basic Addition.',
    },
  });

  assert.equal(review.isValid, true);
  assert.equal(publication.isValid, false);
  assert.equal(publication.scope_validation.code, 'QUESTION_TOPIC_MISMATCH');
  assert.match(publication.document_errors.join(' '), /Question 3 conflicts with selected Topic: Basic Addition/i);
});
