const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArtifacts } = require('./build-per-question-review-manifest');

test('local artifact generator reads a supplied snapshot and writes review artifacts without a database connection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'question-review-artifacts-'));
  try {
    const questionsRoot = path.join(root, 'Questions');
    const snapshotPath = path.join(root, 'snapshot.json');
    const manifestOutputPath = path.join(root, 'artifacts', 'manifest.json');
    const reportOutputPath = path.join(root, 'artifacts', 'review.md');
    fs.mkdirSync(path.join(questionsRoot, 'Grade1', 'Easy'), { recursive: true });
    fs.writeFileSync(path.join(questionsRoot, 'Grade1', 'Easy', 'explicit.json'), JSON.stringify({
      questions: [{
        question: 'What is 2 + 2?',
        choices: ['3', '4'],
        correct_answer: '4',
        topic: 'Basic Addition',
      }],
    }));
    fs.writeFileSync(snapshotPath, JSON.stringify({ question_fingerprints: [] }));

    const manifest = buildArtifacts({
      questionsRoot,
      snapshotPath,
      manifestOutputPath,
      reportOutputPath,
      generatedAt: '2026-08-21T00:00:00.000Z',
    });

    assert.equal(manifest.mode, 'local-review-only');
    assert.equal(manifest.questions[0].status, 'CONFIRMED');
    assert.equal(manifest.questions[0].game_location, 'Oakleaf Village');
    assert.equal(JSON.parse(fs.readFileSync(manifestOutputPath, 'utf8')).questions.length, 1);
    assert.match(fs.readFileSync(reportOutputPath, 'utf8'), /Per-Question Client Bundle Review/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
