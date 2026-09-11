const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  discoverQuestionSources,
  parseLegacyJson,
  parseQuestionText,
  sourceHash,
} = require('./questionSourceImport.utils');

const makeSourceWorkspace = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theresian-source-utils-'));
  const easyDirectory = path.join(directory, 'Grade 1', 'Easy');
  const difficultDirectory = path.join(directory, 'Grade 2', 'Hard');
  fs.mkdirSync(easyDirectory, { recursive: true });
  fs.mkdirSync(difficultDirectory, { recursive: true });
  fs.writeFileSync(path.join(easyDirectory, 'questions.json'), '{}');
  fs.writeFileSync(path.join(difficultDirectory, 'lesson.docx'), 'synthetic docx placeholder');
  return { directory, sourceRoot: directory };
};

test('discovers synthetic legacy source artifacts with relative paths and path metadata', (t) => {
  const workspace = makeSourceWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));
  const sources = discoverQuestionSources(workspace.sourceRoot);

  assert.deepEqual(sources.map((source) => source.relativePath), [
    'Grade 1/Easy/questions.json',
    'Grade 2/Hard/lesson.docx',
  ]);
  assert.deepEqual(sources.map((source) => source.metadata), [
    { grade_level: 'Grade 1', difficulty: 'Easy' },
    { grade_level: 'Grade 2', difficulty: 'Difficult' },
  ]);
  assert.ok(sources.every((source) => ['.docx', '.json'].includes(source.extension)));
  assert.ok(sources.every((source) => source.relativePath && !path.isAbsolute(source.relativePath)));
});

test('normalizes the legacy wrapped JSON format used by the restored source', () => {
  const result = parseLegacyJson({
    questions: [{
      question_id: 'g1_oak_bandit_add_001',
      grade: 'Grade 1',
      topic: 'math',
      difficulty: 'easy',
      question_text: '2 + 2 = ?',
      choices: ['3', '4', '5'],
      correct_answer: '4',
    }],
  }, { grade_level: 'Grade 1', difficulty: 'Easy' });

  assert.deepEqual(result.questions, [{
    source_question_id: 'g1_oak_bandit_add_001',
    question: '2 + 2 = ?',
    options: ['3', '4', '5'],
    correct_answer: '4',
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: null,
  }]);
  assert.deepEqual(result.skipped, []);
});

test('parses explicit answers using current Grade and Difficulty metadata without requiring a topic', () => {
  const result = parseQuestionText(`
    1. Which number completes the pattern?
    A. 4
    B. 6
    C. 8
    D. 10
    Answer: 6
  `, { grade_level: 'Grade 3', difficulty: 'Normal' });

  assert.deepEqual(result.questions, [{
    question: 'Which number completes the pattern?',
    options: ['4', '6', '8', '10'],
    correct_answer: '6',
    grade_level: 'Grade 3',
    difficulty: 'Normal',
    math_topic: null,
  }]);
  assert.deepEqual(result.skipped, []);
});

test('skips text with incomplete choices or no explicit answer', () => {
  const result = parseQuestionText(`
    Lesson: Number Theory
    1. Which number is prime?
    A. 4
    B. 6
    C. 7
  `, { grade_level: 'Grade 4', difficulty: 'Easy' });

  assert.deepEqual(result.questions, []);
  assert.equal(result.skipped.length, 1);
});

test('uses a stable source hash for idempotent imports', () => {
  const metadata = { grade_level: 'Grade 1', difficulty: 'Easy' };
  assert.equal(sourceHash(Buffer.from('source'), metadata), sourceHash(Buffer.from('source'), metadata));
  assert.notEqual(sourceHash(Buffer.from('source'), metadata), sourceHash(Buffer.from('changed'), metadata));
  assert.notEqual(
    sourceHash(Buffer.from('source'), metadata, 'Grade 1/Easy/a.json'),
    sourceHash(Buffer.from('source'), metadata, 'Grade 1/Easy/b.json'),
  );
});
