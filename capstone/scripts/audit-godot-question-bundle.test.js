const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  canonicalDifficulty,
  inferMetadata,
  normalizeQuestion,
} = require('./audit-godot-question-bundle');

test('dry-run question audit canonicalizes legacy difficulty folders without changing files', () => {
  assert.equal(canonicalDifficulty('Normal'), 'Medium');
  assert.equal(canonicalDifficulty('Difficult'), 'Hard');
  assert.equal(canonicalDifficulty('Easy'), 'Easy');

  const metadata = inferMetadata(
    'C:/Questions',
    path.join('C:/Questions', 'grade 3', 'Normal', 'average.docx')
  );
  assert.equal(metadata.grade, 'Grade 3');
  assert.equal(metadata.difficulty, 'Medium');
});

test('dry-run question audit resolves a letter answer to its supplied choice', () => {
  assert.deepEqual(normalizeQuestion({
    question: 'What is 2 + 2?',
    choices: ['3', '4', '5'],
    correct_answer: 'B. 4',
  }), {
    question: 'What is 2 + 2?',
    choices: ['3', '4', '5'],
    answer: '4',
    topic: null,
  });
});
