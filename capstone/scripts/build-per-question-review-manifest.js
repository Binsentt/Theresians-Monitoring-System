#!/usr/bin/env node

// Local-only review artifact generator. It reads a bundled Godot Questions
// directory and an already-captured PostgreSQL fingerprint snapshot; it never
// opens a database connection, imports questions, or changes the Godot bundle.
const fs = require('fs');
const path = require('path');
const { auditGodotQuestionBundle } = require('./audit-godot-question-bundle');
const {
  buildPerQuestionReviewManifest,
  buildReviewReport,
} = require('./question-review-manifest');

const usage = () => {
  console.error('Usage: node scripts/build-per-question-review-manifest.js <Godot-Questions-dir> <fingerprint-snapshot.json> <manifest-output.json> <review-output.md>');
};

const buildArtifacts = ({ questionsRoot, snapshotPath, manifestOutputPath, reportOutputPath, generatedAt = null }) => {
  const audit = auditGodotQuestionBundle(path.resolve(questionsRoot));
  const productionSnapshot = JSON.parse(fs.readFileSync(path.resolve(snapshotPath), 'utf8'));
  const manifest = buildPerQuestionReviewManifest({
    audit,
    productionSnapshot,
    generatedAt: generatedAt || new Date().toISOString(),
  });
  const report = buildReviewReport(manifest);
  fs.mkdirSync(path.dirname(path.resolve(manifestOutputPath)), { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(reportOutputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(manifestOutputPath), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.resolve(reportOutputPath), report);
  return manifest;
};

if (require.main === module) {
  const [questionsRoot, snapshotPath, manifestOutputPath, reportOutputPath] = process.argv.slice(2);
  if (!questionsRoot || !snapshotPath || !manifestOutputPath || !reportOutputPath) {
    usage();
    process.exitCode = 1;
  } else {
    const manifest = buildArtifacts({ questionsRoot, snapshotPath, manifestOutputPath, reportOutputPath });
    console.log(JSON.stringify({
      mode: manifest.mode,
      production_import_performed: false,
      question_count: manifest.questions.length,
      source_issue_count: manifest.source_issues.length,
    }));
  }
}

module.exports = { buildArtifacts };
