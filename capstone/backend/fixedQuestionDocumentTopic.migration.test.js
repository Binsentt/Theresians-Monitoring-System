const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('document-topic migration is additive and permits an unscoped fixed-question document without rewriting historical topics', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, 'migrations', '011_add_learning_file_document_topic.sql'),
    'utf8'
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS document_topic/i);
  assert.match(migration, /ALTER COLUMN math_topic DROP NOT NULL/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.learning_files/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
});

test('activity-event-key migration is additive and protects canonical quest-event retries without rewriting history', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, 'migrations', '012_add_activity_log_event_idempotency.sql'),
    'utf8'
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS event_key/i);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*activity_logs_student_event_key_unique/i);
  assert.match(migration, /\(student_id, event_key\)[\s\S]*WHERE event_key IS NOT NULL/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.activity_logs/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
});

test('AI-generation idempotency migration is additive and protects both replays and concurrent duplicate requests', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, 'migrations', '013_add_ai_generation_idempotency.sql'),
    'utf8'
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS generation_idempotency_key/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS generation_request_fingerprint/i);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*learning_files_lesson_generation_idempotency_unique/i);
  assert.match(migration, /\(uploaded_by, generation_idempotency_key\)[\s\S]*generation_idempotency_key IS NOT NULL/i);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*learning_files_lesson_generation_in_progress_fingerprint_unique/i);
  assert.match(migration, /generation_status = 'generating'/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.learning_files/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
  assert.doesNotMatch(migration, /TRUNCATE/i);
});

test('question-set approval migration adds review state without rewriting question content or history', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, 'migrations', '014_add_learning_file_approval.sql'),
    'utf8'
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS approval_status/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS approved_at/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS approved_by/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS approved_content_fingerprint/i);
  assert.match(migration, /review_required/i);
  assert.match(migration, /legacy_active/i);
  assert.match(migration, /UPDATE\s+public\.learning_files[\s\S]*publish_status\s*=\s*'active'/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.questions/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
  assert.doesNotMatch(migration, /TRUNCATE/i);
});

test('lesson-source lineage migration is additive and preserves legacy question sets', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, 'migrations', '015_add_lesson_source_lineage.sql'),
    'utf8'
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS content_role/i);
  assert.match(migration, /DEFAULT 'question_set'/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS source_learning_file_id/i);
  assert.match(migration, /REFERENCES public\.learning_files\(id\) ON DELETE RESTRICT/i);
  assert.match(migration, /lesson_source/i);
  assert.match(migration, /question_set/i);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS[\s\S]*source_learning_file_id/i);
  assert.doesNotMatch(migration, /DROP\s+/i);
  assert.doesNotMatch(migration, /TRUNCATE/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.questions/i);
});
