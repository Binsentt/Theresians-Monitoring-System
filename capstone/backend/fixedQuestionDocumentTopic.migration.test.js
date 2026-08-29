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
