const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPerQuestionReviewManifest,
  buildProspectiveImportGroups,
  buildCoverageMatrix,
  buildReviewReport,
  canonicalDifficultyAndLocation,
  stableQuestionFingerprint,
} = require('./question-review-manifest');

const validQuestion = {
  question: 'What is 2 + 2?',
  choices: ['3', '4', '5'],
  answer: '4',
};

const auditRecord = ({
  path = 'Grade1/Easy/questions.json',
  grade = 'Grade 1',
  difficulty = 'Easy',
  legacyDifficulty = null,
  sourceTopicHeader = null,
  questions = [validQuestion],
  sourceQuestions = questions,
} = {}) => ({
  path,
  grade,
  difficulty,
  legacy_difficulty: legacyDifficulty,
  source_topic_header: sourceTopicHeader,
  topic_options: ['Basic Addition', 'Subtraction', 'Shapes', 'Place Value'],
  questions,
  source_questions: sourceQuestions,
  malformed_details: [],
});

test('stable question fingerprints normalize superficial casing and whitespace', () => {
  assert.equal(
    stableQuestionFingerprint(validQuestion),
    stableQuestionFingerprint({
      question: '  WHAT  IS  2 + 2? ',
      options: [' 3 ', '4', '5'],
      correct_answer: ' 4 ',
    })
  );
  assert.match(stableQuestionFingerprint(validQuestion), /^[a-f0-9]{64}$/);
});

test('difficulty normalization maps legacy folders to the authoritative game location', () => {
  assert.deepEqual(canonicalDifficultyAndLocation('Normal'), {
    canonical_difficulty: 'Medium',
    game_location: 'City of Knowledge',
  });
  assert.deepEqual(canonicalDifficultyAndLocation('Difficult'), {
    canonical_difficulty: 'Hard',
    game_location: 'Pinehill Village',
  });
  assert.deepEqual(canonicalDifficultyAndLocation('Easy'), {
    canonical_difficulty: 'Easy',
    game_location: 'Oakleaf Village',
  });
});

test('manifest keeps represented, duplicate, malformed, and unconfirmed questions separate', () => {
  const fingerprint = stableQuestionFingerprint(validQuestion);
  const audit = {
    records: [
      auditRecord({
        path: 'Grade1/Easy/000-represented.json',
        sourceTopicHeader: 'Basic Addition',
      }),
      auditRecord({
        path: 'Grade1/Easy/duplicate.json',
        sourceTopicHeader: 'Basic Addition',
      }),
      auditRecord({
        path: 'Grade1/Easy/ambiguous.json',
        questions: [{ ...validQuestion, question: 'Which number comes after 8?' }],
        sourceQuestions: [{ ...validQuestion, question: 'Which number comes after 8?' }],
      }),
      auditRecord({
        path: 'Grade1/Easy/malformed.json',
        questions: [],
        sourceQuestions: [{
          invalid: true,
          reason: 'Missing correct answer.',
          raw_question_text: 'Broken question',
          raw_choices: ['1', '2'],
          raw_correct_answer: null,
        }],
      }),
    ],
  };

  const manifest = buildPerQuestionReviewManifest({
    audit,
    productionSnapshot: { question_fingerprints: [{ question_fingerprint: fingerprint, learning_file_id: 8 }] },
  });

  const represented = manifest.questions.find((question) => question.source_file.endsWith('/000-represented.json'));
  const duplicate = manifest.questions.find((question) => question.source_file.endsWith('/duplicate.json'));
  const ambiguous = manifest.questions.find((question) => question.source_file.endsWith('/ambiguous.json'));
  const malformed = manifest.questions.find((question) => question.source_file.endsWith('/malformed.json'));
  assert.equal(represented.status, 'ALREADY REPRESENTED');
  assert.equal(represented.represented.learning_file_id, 8);
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.equal(duplicate.duplicate_of.source_file, 'Grade1/Easy/000-represented.json');
  assert.equal(ambiguous.status, 'NEEDS MANUAL CONFIRMATION');
  assert.equal(ambiguous.proposed_topic, null);
  assert.equal(ambiguous.confirmed_topic, null);
  assert.equal(malformed.status, 'MALFORMED');
  assert.match(malformed.stable_fingerprint, /^[a-f0-9]{64}$/);
});

test('only controlled explicit or uniquely determined topics become confirmed', () => {
  const audit = {
    records: [
      auditRecord({
        sourceTopicHeader: 'Basic Addition',
        questions: [{ ...validQuestion, question: 'What is 4 + 4?' }],
        sourceQuestions: [{ ...validQuestion, question: 'What is 4 + 4?' }],
      }),
      {
        ...auditRecord({
          path: 'Grade4/Easy/single-topic.json',
          grade: 'Grade 4',
          difficulty: 'Easy',
        sourceTopicHeader: null,
        questions: [{ ...validQuestion, question: 'What is a factor of 8?' }],
        sourceQuestions: [{ ...validQuestion, question: 'What is a factor of 8?' }],
        }),
        topic_options: ['Number Theory'],
      },
      auditRecord({
        path: 'Grade1/Easy/invalid-topic.json',
        sourceTopicHeader: 'Math',
        questions: [{ ...validQuestion, question: 'What is 5 + 5?' }],
        sourceQuestions: [{ ...validQuestion, question: 'What is 5 + 5?' }],
      }),
    ],
  };

  const manifest = buildPerQuestionReviewManifest({ audit, productionSnapshot: { question_fingerprints: [] } });
  const explicit = manifest.questions.find((question) => question.source_file.endsWith('/questions.json'));
  const singleTopic = manifest.questions.find((question) => question.source_file.endsWith('/single-topic.json'));
  const invalidTopic = manifest.questions.find((question) => question.source_file.endsWith('/invalid-topic.json'));
  assert.equal(explicit.confirmed_topic, 'Basic Addition');
  assert.equal(explicit.status, 'CONFIRMED');
  assert.equal(singleTopic.confirmed_topic, 'Number Theory');
  assert.equal(singleTopic.status, 'CONFIRMED');
  assert.equal(invalidTopic.confirmed_topic, null);
  assert.equal(invalidTopic.status, 'NEEDS MANUAL CONFIRMATION');
});

test('a fingerprint-keyed deterministic review assignment is confirmed only when it remains inside the controlled vocabulary', () => {
  const fingerprint = stableQuestionFingerprint(validQuestion);
  const manifest = buildPerQuestionReviewManifest({
    audit: { records: [auditRecord({ sourceTopicHeader: null })] },
    productionSnapshot: { question_fingerprints: [] },
    deterministicTopicAssignments: {
      [fingerprint]: {
        topic: 'Shapes',
        reason: 'The exact reviewed question asks for a geometric shape.',
      },
    },
  });
  assert.equal(manifest.questions[0].confirmed_topic, 'Shapes');
  assert.equal(manifest.questions[0].status, 'CONFIRMED');

  const invalidAssignment = buildPerQuestionReviewManifest({
    audit: { records: [auditRecord({ sourceTopicHeader: null })] },
    productionSnapshot: { question_fingerprints: [] },
    deterministicTopicAssignments: {
      [fingerprint]: { topic: 'Fractions', reason: 'Invalid controlled scope.' },
    },
  });
  assert.equal(invalidAssignment.questions[0].status, 'NEEDS MANUAL CONFIRMATION');
  assert.equal(invalidAssignment.questions[0].confirmed_topic, null);
});

test('prospective import groups consume confirmed topics only and never infer topics during apply preparation', () => {
  const manifest = buildPerQuestionReviewManifest({
    audit: {
      records: [
        auditRecord({ sourceTopicHeader: 'Basic Addition' }),
        auditRecord({
          path: 'Grade1/Normal/review.json',
          difficulty: 'Medium',
          legacyDifficulty: 'Normal',
          sourceTopicHeader: null,
          questions: [{ ...validQuestion, question: 'Which number comes after 8?' }],
          sourceQuestions: [{ ...validQuestion, question: 'Which number comes after 8?' }],
        }),
      ],
    },
    productionSnapshot: { question_fingerprints: [] },
  });

  const groups = buildProspectiveImportGroups(manifest);
  assert.deepEqual(groups, [{
    grade: 'Grade 1',
    canonical_difficulty: 'Easy',
    topic: 'Basic Addition',
    game_location: 'Oakleaf Village',
    question_count: 1,
    question_fingerprints: [stableQuestionFingerprint(validQuestion)],
  }]);
  assert.equal(manifest.questions[1].status, 'NEEDS MANUAL CONFIRMATION');
});

test('coverage matrix and review report preserve no-data cells and manual decisions without inventing import eligibility', () => {
  const manifest = buildPerQuestionReviewManifest({
    audit: {
      records: [
        auditRecord({ sourceTopicHeader: 'Basic Addition' }),
        auditRecord({
          path: 'Grade6/Difficult/review.json',
          grade: 'Grade 6',
          difficulty: 'Hard',
          legacyDifficulty: 'Difficult',
          sourceTopicHeader: null,
          questions: [{ ...validQuestion, question: 'Which fraction is largest?' }],
          sourceQuestions: [{ ...validQuestion, question: 'Which fraction is largest?' }],
        }),
      ],
    },
    productionSnapshot: { question_fingerprints: [] },
  });

  const matrix = buildCoverageMatrix(manifest);
  assert.deepEqual(matrix.find((row) => row.grade === 'Grade 1').Easy, {
    confirmed: 1,
    needs_manual_confirmation: 0,
    already_represented: 0,
    duplicate: 0,
    malformed: 0,
  });
  assert.deepEqual(matrix.find((row) => row.grade === 'Grade 6').Hard, {
    confirmed: 0,
    needs_manual_confirmation: 1,
    already_represented: 0,
    duplicate: 0,
    malformed: 0,
  });
  const report = buildReviewReport(manifest);
  assert.match(report, /Grade 6 \| Hard \| Pinehill Village/);
  assert.match(report, /Needs Manual Confirmation/);
  assert.match(report, /Which fraction is largest\?/);
});
